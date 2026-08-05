import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

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
  process.env.ALLOWED_ORIGINS = "http://trusted.example:3000";
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

  it("blocks the opaque \"null\" origin a sandboxed iframe sends", async () => {
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

  it("blocks a CORS-simple POST to browser/start, which takes no body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/vk-demo-1/browser/start",
      headers: { host: "pod:8080", origin: "http://evil.example" },
    });
    expect(res.statusCode).toBe(403);
  });
});

// The reason the whole check exists: websockets are exempt from CORS, so a page
// the user visits on the VPN could otherwise attach to a session terminal.
describe("origin check on the websocket upgrade", () => {
  /** Hand-rolled so the assertion is about the handshake itself, not a client library. */
  const handshake = (origin?: string) =>
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
});
