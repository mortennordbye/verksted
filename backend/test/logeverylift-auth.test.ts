import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Signing in to LogEveryLift, short of LogEveryLift: the URL it sends you to, the
 * state that has to come back, what is kept, and when the token is refreshed. The
 * service's endpoints are stubbed, which is the whole of the network.
 */
let app: FastifyInstance;
let lel: typeof import("../src/logeverylift-auth.js");
let settings: typeof import("../src/settings-store.js");

const ISSUER = "https://logeverylift.com/api/auth";
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/** What the token endpoint answers next, and every form it was sent. */
let tokenAnswer: () => Response;
let tokenForms: URLSearchParams[];

function stubService() {
  tokenForms = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("oauth-protected-resource")) {
        return json({
          resource: "https://logeverylift.com/api/mcp",
          authorization_servers: [ISSUER],
        });
      }
      if (u.includes("oauth-authorization-server") || u.includes("openid-configuration")) {
        return json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/oauth2/authorize`,
          token_endpoint: `${ISSUER}/oauth2/token`,
          registration_endpoint: `${ISSUER}/oauth2/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (u.endsWith("/oauth2/register")) {
        const sent = JSON.parse(init?.body as string) as { redirect_uris: string[] };
        return json({ client_id: "client-1", redirect_uris: sent.redirect_uris }, 201);
      }
      if (u.endsWith("/oauth2/token")) {
        tokenForms.push(new URLSearchParams(init?.body as string));
        return tokenAnswer();
      }
      throw new Error(`unexpected request to ${u}`);
    }),
  );
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-lel-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  delete process.env.PUBLIC_URL;
  process.env.ALLOWED_ORIGINS = "https://verksted.local.bigd.no";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  lel = await import("../src/logeverylift-auth.js");
  settings = await import("../src/settings-store.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  stubService();
  await settings.writeVars({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOST = { host: "verksted.local.bigd.no" };

/** The whole sign-in, as the browser would walk it. */
async function signIn(answer: Record<string, unknown>) {
  tokenAnswer = () => json({ token_type: "Bearer", ...answer });
  const start = await app.inject({ url: "/api/connectors/logeverylift/start", headers: HOST });
  const to = new URL(start.headers.location as string);
  const cookie = String(start.headers["set-cookie"]).split(";")[0];
  const back = await app.inject({
    url: `${lel.CALLBACK_PATH}?code=abc&state=${to.searchParams.get("state")}`,
    headers: { ...HOST, cookie },
  });
  return { to, back };
}

const kept = async () => JSON.parse((await settings.readVars()).LOGEVERYLIFT_TOKENS ?? "null");

describe("signing in", () => {
  it("sends the browser to the consent page for a token bound to the MCP server", async () => {
    const { to } = await signIn({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });

    expect(to.origin + to.pathname).toBe(`${ISSUER}/oauth2/authorize`);
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.searchParams.get("resource")).toBe("https://logeverylift.com/api/mcp");
    expect(to.searchParams.get("scope")).toContain("offline_access");
    expect(to.searchParams.get("redirect_uri")).toBe(
      `https://verksted.local.bigd.no${lel.CALLBACK_PATH}`,
    );
  });

  it("keeps the tokens, and proves the code with the verifier it started with", async () => {
    const { back } = await signIn({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });

    expect(back.headers.location).toContain("logeverylift=ok");
    expect(await kept()).toMatchObject({ access: "a1", refresh: "r1" });
    expect(tokenForms[0].get("grant_type")).toBe("authorization_code");
    expect(tokenForms[0].get("code_verifier")).toBeTruthy();
    expect((await lel.status()).connected).toBe(true);
  });

  it("refuses a callback that does not carry the state it started", async () => {
    const res = await app.inject({
      url: `${lel.CALLBACK_PATH}?code=abc&state=forged`,
      headers: { ...HOST, cookie: `${lel.STATE_COOKIE}=forged` },
    });

    expect(res.headers.location).toContain("logeverylift_error");
    expect(tokenForms).toEqual([]);
    expect(await kept()).toBeNull();
  });

  it("forgets the sign-in on disconnect", async () => {
    await signIn({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });

    await app.inject({
      method: "POST",
      url: "/api/connectors/logeverylift/disconnect",
      headers: HOST,
    });

    expect(await lel.accessToken()).toBeNull();
    expect((await lel.status()).connected).toBe(false);
  });
});

describe("the token a turn is handed", () => {
  it("is null with nobody signed in", async () => {
    expect(await lel.accessToken()).toBeNull();
  });

  it("is the kept one while it has time on it, with no request made", async () => {
    await signIn({ access_token: "a1", refresh_token: "r1", expires_in: 3600 });
    tokenForms = [];

    expect(await lel.accessToken()).toBe("a1");
    expect(tokenForms).toEqual([]);
  });

  it("is refreshed once when it is close to running out, however many ask at once", async () => {
    await signIn({ access_token: "old", refresh_token: "r1", expires_in: 60 });
    tokenForms = [];
    tokenAnswer = () =>
      json({ token_type: "Bearer", access_token: "new", refresh_token: "r2", expires_in: 3600 });

    const got = await Promise.all([lel.accessToken(), lel.accessToken(), lel.accessToken()]);

    expect(got).toEqual(["new", "new", "new"]);
    expect(tokenForms).toHaveLength(1);
    expect(tokenForms[0].get("refresh_token")).toBe("r1");
    expect(tokenForms[0].get("resource")).toBe("https://logeverylift.com/api/mcp");
    expect(await kept()).toMatchObject({ access: "new", refresh: "r2" });
  });

  it("keeps the refresh token when the service does not rotate it", async () => {
    await signIn({ access_token: "old", refresh_token: "r1", expires_in: 60 });
    tokenAnswer = () => json({ token_type: "Bearer", access_token: "new", expires_in: 3600 });

    await lel.accessToken();

    expect((await kept()).refresh).toBe("r1");
  });

  it("says the sign-in was refused only when the service says so", async () => {
    await signIn({ access_token: "old", refresh_token: "r1", expires_in: -10 });
    tokenAnswer = () => json({ error: "invalid_grant", error_description: "revoked" }, 400);

    expect(await lel.accessToken()).toBeNull();
    expect((await lel.status()).error).toMatch(/revoked/);
  });

  it("does not call a network fault a refusal, and hands over what still works", async () => {
    await signIn({ access_token: "old", refresh_token: "r1", expires_in: 60 });
    tokenAnswer = () => new Response("bad gateway", { status: 502 });

    expect(await lel.accessToken()).toBe("old");
    expect((await lel.status()).error).toBeNull();
  });
});

describe("where the sign-in goes", () => {
  beforeEach(async () => {
    await signIn({
      access_token: "secret-access",
      refresh_token: "secret-refresh",
      expires_in: 3600,
    });
  });

  it("is never handed to a session", async () => {
    const { agentEnv } = await import("../src/settings-store.js");

    const vars = await agentEnv();

    expect(JSON.stringify(vars)).not.toContain("secret");
  });

  it("reaches a speaker holding connectors, and nobody else", async () => {
    const { turnEnv } = await import("../src/assistant-policy.js");

    expect((await turnEnv(true)).LOGEVERYLIFT_TOKEN).toBe("secret-access");
    expect((await turnEnv(false)).LOGEVERYLIFT_TOKEN).toBeUndefined();
    expect(JSON.stringify(await turnEnv(true))).not.toContain("secret-refresh");
  });

  it("offers the chair the server by name of variable, leaving the file clean", async () => {
    const { ensureMcpConfig } = await import("../src/assistant-policy.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-lel-mcp-"));
    const { env } = await import("../src/env.js");
    const before = env.ASSISTANT_DIR;
    env.ASSISTANT_DIR = dir;
    try {
      const file = await ensureMcpConfig({
        id: "chair",
        tools: null,
        unattended: false,
        turn: "t",
      });
      const text = fs.readFileSync(file, "utf8");
      const config = JSON.parse(text);

      expect(config.mcpServers.logeverylift.url).toBe("https://logeverylift.com/api/mcp");
      expect(config.mcpServers.logeverylift.headers.Authorization).toBe(
        "Bearer ${LOGEVERYLIFT_TOKEN}",
      );
      expect(text).not.toContain("secret");

      const advisor = await ensureMcpConfig({
        id: "ariel",
        tools: [],
        unattended: false,
        turn: "t",
      });
      expect(JSON.parse(fs.readFileSync(advisor, "utf8")).mcpServers).toEqual({});
    } finally {
      env.ASSISTANT_DIR = before;
    }
  });
});
