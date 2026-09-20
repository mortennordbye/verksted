import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, FastifyRequest } from "fastify";

let app: FastifyInstance;
let port: number;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SETTINGS_FILE = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "vk-settings-")),
    "settings.json",
  );
  process.env.STATIC_DIR = "";
  // "pod" is the name these cases address the app by; a name the deployment
  // was never told about is refused before the origin check (see the host
  // suite below), which would make every case here pass for the wrong reason.
  process.env.ALLOWED_ORIGINS = "http://trusted.example:3000,http://pod:8080";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
});

describe("origin check on mutating requests", () => {
  it("allows a request with no Origin (curl from an agent, health probes)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: {} });
    expect(res.statusCode).not.toBe(403);
  });

  it("allows same-origin, comparing host:port so http and https both work", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "pod:8080", origin: "http://pod:8080" },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it("blocks a foreign origin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "pod:8080", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "origin not allowed" });
  });

  it("blocks a foreign origin that only shares the hostname", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "pod:8080", origin: "http://pod:3000" },
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks the opaque "null" origin a sandboxed iframe sends', async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "pod:8080", origin: "null" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("allows an origin listed in ALLOWED_ORIGINS", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "pod:8080", origin: "http://trusted.example:3000" },
    });
    expect(res.statusCode).not.toBe(403);
  });

  it("covers every mutating method, and leaves reads alone", async () => {
    const headers = { host: "pod:8080", origin: "http://evil.example" };
    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const res = await app.inject({ method, url: "/api/projects/demo", payload: {}, headers });
      expect(res.statusCode, method).toBe(403);
    }
    // A cross-origin GET cannot be read back by the attacker anyway, and
    // blocking it would break nothing that matters.
    const read = await app.inject({ method: "GET", url: "/api/health", headers });
    expect(read.statusCode).toBe(200);
  });

  it("blocks a cross-origin event stream, which EventSource can read back", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/events",
      headers: { host: "pod:8080", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("blocks a CORS-simple POST to browser/start, which takes no body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/vk-demo-1/browser/start",
      headers: { host: "pod:8080", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });
});

/**
 * DNS rebinding: a page on a name the attacker controls, re-resolved to the
 * pod. Host and Origin then agree, so the origin check above is satisfied by
 * every request the page makes — this is what stops it.
 */
describe("host check", () => {
  const get = (host: string, url = "/api/health") => app.inject({ method: "GET", url, headers: { host } });

  it("refuses a name this deployment was never told about", async () => {
    const res = await get("evil.example:8080");
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: "host not allowed" });
  });

  it("refuses it on a mutating request whose Origin agrees with it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {},
      headers: { host: "evil.example:8080", origin: "http://evil.example:8080" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("answers for a name it was told about, on any port", async () => {
    expect((await get("trusted.example:3000")).statusCode).toBe(200);
    expect((await get("trusted.example")).statusCode).toBe(200);
  });

  /**
   * A browser will not rebind onto a literal address, and these are how the
   * kubelet's probes, kubectl port-forward, `make run` and a phone on the LAN
   * reach the app.
   */
  it("answers on a literal address", async () => {
    for (const host of ["127.0.0.1:8080", "10.42.0.17:8080", "[::1]:8080", "localhost:5173"]) {
      expect((await get(host)).statusCode, host).toBe(200);
    }
  });

  it("is not fooled by a name that looks like hex", async () => {
    expect((await get("cafe.example")).statusCode).toBe(403);
    expect((await get("dead:8080")).statusCode).toBe(403);
  });

  // Not reachable through inject, which supplies a Host of its own.
  it("refuses a request with no Host at all", async () => {
    const { hostAllowed } = await import("../src/origin.js");
    expect(hostAllowed({ headers: {} } as FastifyRequest)).toBe(false);
  });
});

describe("security headers", () => {
  it("refuses framing, and confines what a rendered reply may load", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "pod:8080" },
    });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).toContain("default-src 'self'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  // PUBLIC_URL is http here; the pod itself is only reached over http.
  it("does not demand https where the deployment is not https", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { host: "pod:8080" },
    });
    expect(res.headers["strict-transport-security"]).toBeUndefined();
  });
});

describe("error responses", () => {
  // Fastify's default answers a thrown error with its message, and
  // createSession's message is the whole tmux command line, -e GH_TOKEN=...
  // included. The same body was also what the UI showed.
  it("says nothing about why a 500 happened", async () => {
    const { buildApp } = await import("../src/app.js");
    const thrower = await buildApp({ logger: false });
    thrower.get("/api/boom", async () => {
      // What execFile rejects with when a session fails to start.
      throw new Error("Command failed: tmux new-session -e GH_TOKEN=ghp_secret");
    });

    const res = await thrower.inject({ url: "/api/boom", headers: { host: "pod:8080" } });

    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal error" });
    expect(res.body).not.toContain("ghp_secret");
    await thrower.close();
  });

  it("keeps a rejected request's own reason, in the one shape the client reads", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { url: 42 },
      headers: { host: "pod:8080" },
    });
    expect(res.statusCode).toBe(400);
    expect(typeof res.json().error).toBe("string");
    expect(res.json()).not.toHaveProperty("statusCode");
  });
});

// The reason the whole check exists: websockets are exempt from CORS, so a page
// the user visits on the VPN could otherwise attach to a session terminal.
describe("origin check on the websocket upgrade", () => {
  /** Hand-rolled so the assertion is about the handshake itself, not a client library. */
  const handshake = (origin?: string, host?: string) =>
    new Promise<{ upgraded: boolean; status?: number }>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/sessions/vk-demo-1/attach",
        headers: {
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-key": Buffer.from("0123456789abcdef").toString("base64"),
          "sec-websocket-version": "13",
          ...(origin === undefined ? {} : { origin }),
          ...(host === undefined ? {} : { host }),
        },
      });
      // A 101 means the hook let it through to the route, which then closes it
      // as an unknown session.
      req.on("upgrade", (_res, socket) => {
        socket.destroy();
        resolve({ upgraded: true });
      });
      req.on("response", (res) => {
        res.resume();
        resolve({ upgraded: false, status: res.statusCode });
      });
      req.on("error", () => resolve({ upgraded: false }));
      req.end();
    });

  it("rejects the handshake from a foreign origin", async () => {
    expect(await handshake("http://evil.example")).toEqual({ upgraded: false, status: 403 });
  });

  it("lets a same-origin handshake through to the route", async () => {
    expect(await handshake(`http://127.0.0.1:${port}`)).toEqual({ upgraded: true });
  });

  it("lets a non-browser client with no Origin through", async () => {
    expect(await handshake()).toEqual({ upgraded: true });
  });

  // The rebinding shape: Host and Origin agree, so the origin check alone
  // would hand this page a root shell.
  it("rejects a handshake addressed to a name the deployment does not answer for", async () => {
    expect(await handshake("http://evil.example:8080", "evil.example:8080")).toEqual({
      upgraded: false,
      status: 403,
    });
  });
});
