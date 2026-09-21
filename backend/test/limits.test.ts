import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The ceilings of S-09 that are not about sessions: a volume with no room left,
 * and a route asked for more often than anything real would ask.
 */
let fake: FakeBin;
let app: FastifyInstance;
let reposDir: string;

beforeAll(async () => {
  fake = FakeBin.install(["gh", "tmux"]);
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-limits-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-limits-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-limits-sched-"));
  process.env.FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-limits-feed-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

afterEach(() => vi.restoreAllMocks());

/** A volume with this much left, as statfs would say it. */
function free(bytes: number) {
  vi.spyOn(fsp, "statfs").mockResolvedValue({ bavail: bytes / 4096, bsize: 4096 } as never);
}

describe("a volume with no room", () => {
  it("refuses a clone before gh is run, and says why", async () => {
    free(100 * 1024 ** 2);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { mode: "clone", url: "https://github.com/o/big" },
    });

    expect(res.statusCode).toBe(507);
    expect(res.json().error).toMatch(/not enough free space/);
    expect(fake.argvFor("gh")).toEqual([]);
  });

  it("refuses an upload the same way", async () => {
    free(10 * 1024 ** 2);
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/upload?filename=shot.png",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("png"),
    });

    expect(res.statusCode).toBe(507);
    expect(fs.existsSync(path.join(reposDir, "demo", ".verksted"))).toBe(false);
  });

  it("does not refuse on a volume that will not say", async () => {
    vi.spyOn(fsp, "statfs").mockRejectedValue(new Error("ENOSYS"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/upload?filename=shot.png",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from("png"),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("a route asked too often", () => {
  it("answers 429 in the app's own error shape once its minute is spent", async () => {
    const hit = () =>
      app.inject({ method: "POST", url: "/api/intake", payload: { title: "t", text: "x" } });
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await hit()).statusCode);

    expect(codes.slice(0, 60).every((c) => c < 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect((await hit()).json()).toHaveProperty("error");
  });

  it("leaves the reads the app polls alone", async () => {
    for (let i = 0; i < 80; i++) {
      expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
    }
  });
});
