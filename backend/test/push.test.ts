import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let pushFile: string;

const sub = (n: number) => ({
  endpoint: `https://push.example/${n}`,
  keys: { p256dh: "BPq".padEnd(87, "x"), auth: "c2VjcmV0" },
});

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-push-"));
  pushFile = path.join(dir, "push.json");

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  process.env.PUSH_FILE = pushFile;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

const stored = () => JSON.parse(fs.readFileSync(pushFile, "utf8"));

describe("GET /api/push", () => {
  it("generates a VAPID keypair on first use and keeps the private half", async () => {
    const res = await app.inject({ method: "GET", url: "/api/push" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(body).not.toHaveProperty("privateKey");
    expect(stored().vapid.privateKey).toBeTruthy();
  });

  it("reuses the same key on the next call — a new one would break every device", async () => {
    const first = (await app.inject({ method: "GET", url: "/api/push" })).json().publicKey;
    const second = (await app.inject({ method: "GET", url: "/api/push" })).json().publicKey;
    expect(second).toBe(first);
  });
});

describe("POST /api/push/subscribe", () => {
  it("stores a subscription and counts the device", async () => {
    const res = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: sub(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json().devices).toBe(1);
    expect(stored().subs[0].endpoint).toBe("https://push.example/1");
  });

  it("refreshes rather than duplicates the same endpoint", async () => {
    await app.inject({ method: "POST", url: "/api/push/subscribe", payload: sub(1) });
    const res = await app.inject({ method: "POST", url: "/api/push/subscribe", payload: sub(1) });
    expect(res.json().devices).toBe(1);
  });

  it("rejects a non-https endpoint", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { ...sub(2), endpoint: "http://push.example/2" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a subscription without keys", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/subscribe",
      payload: { endpoint: "https://push.example/3" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/push/unsubscribe", () => {
  it("drops the device and leaves the others alone", async () => {
    await app.inject({ method: "POST", url: "/api/push/subscribe", payload: sub(4) });
    const res = await app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      payload: { endpoint: "https://push.example/1" },
    });
    expect(res.json().devices).toBe(1);
    expect(stored().subs.map((s: { endpoint: string }) => s.endpoint)).toEqual([
      "https://push.example/4",
    ]);
  });

  it("is a no-op for an endpoint that was never subscribed", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/unsubscribe",
      payload: { endpoint: "https://push.example/nope" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().devices).toBe(1);
  });
});

describe("POST /api/push/send", () => {
  it("refuses a tap target that leaves the app", async () => {
    // A notification renders outside anything this app controls, so an absolute
    // link in one is a phishing link wearing verksted's name. Path-only, and a
    // protocol-relative "//evil.example" is a link off-site too.
    for (const url of ["https://evil.example", "//evil.example", "javascript:alert(1)", "evil"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/push/send",
        payload: { body: "hello", url },
      });
      expect(res.statusCode, url).toBe(400);
    }
  });

  it("sends a message with an in-app path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/send",
      payload: { body: "the nightly run failed", url: "/inbox" },
    });
    expect(res.statusCode).toBe(200);
    // .example cannot resolve, so the send fails — what matters here is that the
    // route accepted the shape and reported the outcome rather than lying.
    expect(res.json()).toMatchObject({ devices: 1, sent: 0, failed: 1 });
  });

  it("requires something to say", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/push/send",
      payload: { title: "x" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not push the same line twice in a row", async () => {
    // The caller that made this necessary is a schedule: an unattended turn
    // starts a fresh conversation every time, so it cannot remember pushing
    // "main is red" an hour ago and would push it again on every tick.
    const payload = { body: "main is red", url: "/inbox" };

    const first = await app.inject({ method: "POST", url: "/api/push/send", payload });
    const second = await app.inject({ method: "POST", url: "/api/push/send", payload });

    expect(first.json().suppressed).toBeUndefined();
    expect(second.json()).toMatchObject({ sent: 0, suppressed: true });
    // Different news still gets through; it is the message that is deduped,
    // not the caller.
    const other = await app.inject({
      method: "POST",
      url: "/api/push/send",
      payload: { body: "main is green again", url: "/inbox" },
    });
    expect(other.json().suppressed).toBeUndefined();
  });
});

describe("POST /api/push/test", () => {
  it("reports a refused push instead of claiming it was sent", async () => {
    const res = await app.inject({ method: "POST", url: "/api/push/test" });
    expect(res.statusCode).toBe(200);
    // The one subscribed endpoint is on .example, which cannot resolve — so the
    // send fails, and the point of this route is that it says so.
    expect(res.json()).toMatchObject({ devices: 1, sent: 0, failed: 1 });
    expect(res.json().error).toBeTruthy();
  });
});
