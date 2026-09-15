import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Google sign-in for the calendar, short of Google: the URL it sends you to,
 * the state that has to come back with the code, and what the callback keeps.
 * The two Google endpoints are stubbed, which is the whole of the network.
 */
let app: FastifyInstance;
let google: typeof import("../src/google-auth.js");
let settings: typeof import("../src/settings-store.js");
let calendar: typeof import("../src/calendar.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-google-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  delete process.env.PUBLIC_URL;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  google = await import("../src/google-auth.js");
  settings = await import("../src/settings-store.js");
  calendar = await import("../src/calendar.js");
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const HOST = "verksted.local.bigd.no";
const CALLBACK = `https://${HOST}/api/calendar/google/callback`;

describe("the sign-in link", () => {
  it("asks for offline calendar access and comes back to this host", () => {
    const url = new URL(google.authUrl("client-1", CALLBACK, "s1"));
    expect(url.origin + url.pathname).toBe(google.AUTH_URL);
    expect(url.searchParams.get("scope")?.split(" ")).toEqual(
      expect.arrayContaining([
        google.CALENDAR_SCOPE,
        google.GMAIL_MODIFY_SCOPE,
        google.GMAIL_SETTINGS_SCOPE,
      ]),
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK);
    expect(url.searchParams.get("state")).toBe("s1");
  });

  it("builds the redirect from the host, https except on localhost", () => {
    expect(google.redirectUri(HOST)).toBe(CALLBACK);
    expect(google.redirectUri("localhost:15173")).toBe(
      "http://localhost:15173/api/calendar/google/callback",
    );
    // Not a host: nothing of it reaches the URL.
    expect(google.redirectUri("evil.example/path?x=")).toBe(
      "http://localhost/api/calendar/google/callback",
    );
  });
});

describe("the state", () => {
  it("passes once, with the matching cookie, and never again", () => {
    const state = google.newState();
    expect(google.takeState(state, state)).toBe(true);
    expect(google.takeState(state, state)).toBe(false);
  });

  it("fails without the cookie, with another cookie, or after ten minutes", () => {
    const a = google.newState();
    expect(google.takeState(a, undefined)).toBe(false);
    const b = google.newState();
    expect(google.takeState(b, google.newState())).toBe(false);
    const c = google.newState(Date.now() - 11 * 60_000);
    expect(google.takeState(c, c)).toBe(false);
  });
});

describe("the routes", () => {
  it("sends you back to settings when there is no client to sign in with", async () => {
    const res = await app.inject({ url: "/api/calendar/google/start", headers: { host: HOST } });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^\/settings\?tab=sources&google_error=/);
  });

  it("refuses a callback whose state it did not hand out", async () => {
    await settings.writeVars({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" });
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const res = await app.inject({
      url: "/api/calendar/google/callback?code=c&state=made-up",
      headers: { host: HOST, cookie: `${google.STATE_COOKIE}=made-up` },
    });

    expect(res.headers.location).toMatch(/google_error=/);
    expect(fetch).not.toHaveBeenCalled();
    expect((await settings.readVars()).GOOGLE_REFRESH_TOKEN).toBeUndefined();
  });

  it("signs in: keeps the refresh token and the address, and the calendar uses them", async () => {
    await settings.writeVars({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" });

    const start = await app.inject({ url: "/api/calendar/google/start", headers: { host: HOST } });
    expect(start.statusCode).toBe(302);
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    const setCookie = String(start.headers["set-cookie"]);
    expect(setCookie).toContain(`${google.STATE_COOKIE}=${state}`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");

    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === google.TOKEN_URL) {
        const body = init?.body as URLSearchParams;
        expect(body.get("code")).toBe("the-code");
        expect(body.get("redirect_uri")).toBe(CALLBACK);
        return Response.json({
          access_token: "at",
          refresh_token: "rt",
          scope: `openid email ${google.CALENDAR_SCOPE}`,
        });
      }
      return Response.json({ email: "morten@nordbye.it" });
    });
    vi.stubGlobal("fetch", fetch);

    const res = await app.inject({
      url: `/api/calendar/google/callback?code=the-code&state=${state}&scope=x&authuser=0`,
      headers: { host: HOST, cookie: `${google.STATE_COOKIE}=${state}` },
    });

    expect(res.headers.location).toBe("/settings?tab=sources&google=ok");
    expect(await calendar.calendarConfig()).toEqual({
      kind: "google",
      user: "morten@nordbye.it",
      clientId: "client-1",
      clientSecret: "secret-1",
      refreshToken: "rt",
    });
    const status = (
      await app.inject({ url: "/api/calendar/google", headers: { host: HOST } })
    ).json();
    expect(status).toEqual({
      clientSet: true,
      account: "morten@nordbye.it",
      redirectUri: CALLBACK,
    });
    // A source credential: the backend reads it, no session is ever handed it.
    expect(await settings.agentEnv()).not.toHaveProperty("GOOGLE_REFRESH_TOKEN");
  });

  it("will not keep a sign-in that left the calendar box unticked", async () => {
    await settings.writeVars({ GOOGLE_CLIENT_ID: "client-1", GOOGLE_CLIENT_SECRET: "secret-1" });
    const start = await app.inject({ url: "/api/calendar/google/start", headers: { host: HOST } });
    const state = new URL(String(start.headers.location)).searchParams.get("state")!;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ access_token: "at", refresh_token: "rt", scope: "openid email" }),
      ),
    );

    const res = await app.inject({
      url: `/api/calendar/google/callback?code=c&state=${state}`,
      headers: { host: HOST, cookie: `${google.STATE_COOKIE}=${state}` },
    });

    expect(res.headers.location).toMatch(/google_error=calendar/);
    expect((await settings.readVars()).GOOGLE_REFRESH_TOKEN).toBeUndefined();
  });

  it("signs out, forgetting the token but keeping the client", async () => {
    await settings.writeVars({
      GOOGLE_CLIENT_ID: "client-1",
      GOOGLE_CLIENT_SECRET: "secret-1",
      GOOGLE_REFRESH_TOKEN: "rt",
      GOOGLE_CALENDAR_USER: "morten@nordbye.it",
    });
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetch);

    const res = await app.inject({
      method: "POST",
      url: "/api/calendar/google/disconnect",
      headers: { host: HOST },
    });

    expect(res.json()).toMatchObject({ clientSet: true, account: null });
    const vars = await settings.readVars();
    expect(vars.GOOGLE_REFRESH_TOKEN).toBeUndefined();
    expect(vars.GOOGLE_CLIENT_ID).toBe("client-1");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
