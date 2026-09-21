import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * How the app is served rather than what it answers: compressed, cacheable
 * where a name can never mean anything else, and able to say whether it is
 * ready and which build it is.
 */
let fake: FakeBin;
let app: FastifyInstance;
let sessionsDir: string;

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);
  const dist = fs.mkdtempSync(path.join(os.tmpdir(), "vk-serve-dist-"));
  fs.mkdirSync(path.join(dist, "assets"));
  fs.writeFileSync(
    path.join(dist, "index.html"),
    '<html><head><script type="module" crossorigin src="/assets/index-Ab12Cd34.js"></script></head></html>',
  );
  fs.writeFileSync(path.join(dist, "assets", "index-Ab12Cd34.js"), `// ${"x".repeat(5_000)}\n`);
  fs.writeFileSync(path.join(dist, "sw.js"), "// worker\n");
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-serve-sess-"));
  process.env.STATIC_DIR = dist;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-serve-repos-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-serve-sched-"));
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

describe("static files (R-29)", () => {
  it("keeps a hashed asset for good, and compresses it", async () => {
    const res = await app.inject({
      url: "/assets/index-Ab12Cd34.js",
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["content-encoding"]).toBe("gzip");
  });

  it("asks again for every name the next build reuses", async () => {
    for (const url of ["/", "/sw.js", "/some/app/route"]) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(200);
      expect(res.headers["cache-control"], url).toBe("no-cache");
    }
  });

  it("compresses what the API answers, once it is big enough to be worth it", async () => {
    const big = await app.inject({ url: "/api/settings", headers: { "accept-encoding": "gzip" } });
    expect(big.statusCode).toBe(200);
    expect(big.headers["content-encoding"]).toBe("gzip");
    const small = await app.inject({ url: "/api/health", headers: { "accept-encoding": "gzip" } });
    expect(small.headers["content-encoding"]).toBeUndefined();
  });
});

describe("health and readiness (R-28)", () => {
  it("names the frontend build it serves, the way the frontend names itself", async () => {
    const res = await app.inject({ url: "/api/health" });
    expect(res.json()).toEqual({ ok: true, build: "index-Ab12Cd34.js" });
  });

  it("is ready with tmux answering and the volume writable", async () => {
    fake.reply("tmux", "ls", { stdout: "" });
    const res = await app.inject({ url: "/api/ready" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ready: true, tmux: true, volume: true });
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("is not ready when tmux cannot be reached, which health never noticed", async () => {
    fake.reply("tmux", "ls", { code: 1, stderr: "connect failed: permission denied" });
    const res = await app.inject({ url: "/api/ready" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ready: false, tmux: false, volume: true });
    fake.reply("tmux", "ls", { stdout: "" });
  });
});
