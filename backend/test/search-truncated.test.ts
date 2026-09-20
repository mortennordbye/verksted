import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * R-32. A search that matches half the repo used to answer 500.
 *
 * `rg` is run with a 4 MB output buffer, and execFile kills the child and
 * rejects the moment that fills — with everything it had already read still on
 * the error. The route threw that away and reported a server fault, although
 * the first 300 lines of it are the answer: the list is capped at 300 on a
 * good day too. The person searching a large repo for `the` got nothing but a
 * red banner.
 *
 * A fake `rg` rather than a repo big enough to do it for real: filling four
 * megabytes of match lines takes thousands of files, and what is under test is
 * what the route does with a kill, not ripgrep.
 */
let app: FastifyInstance;
let fake: FakeBin;
let reposDir: string;

beforeAll(async () => {
  fake = FakeBin.install(["rg"]);
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-search-repos-"));
  const dir = path.join(reposDir, "demo");
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello\n");

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-search-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
  fs.rmSync(reposDir, { recursive: true, force: true });
});

describe("GET /api/projects/:name/search, when rg outruns the buffer", () => {
  it("answers with the hits it had rather than a server error", async () => {
    // Past the route's 4 MB: execFile kills rg part-way through this.
    fake.reply("rg", "--line-number", { stdout: "a.txt:1:hello\n".repeat(350_000) });

    const res = await app.inject({ url: "/api/projects/demo/search?q=hello" });

    expect(res.statusCode).toBe(200);
    // The same cap a search that finished would have been cut to.
    expect(res.json()).toHaveLength(300);
    expect(res.json()[0]).toEqual({ path: "a.txt", line: 1, text: "hello" });
  });

  it("still reports a search that produced nothing at all as a failure", async () => {
    // The distinction worth keeping: a truncated answer is an answer, and rg
    // dying with nothing written is not one.
    fake.reply("rg", "--line-number", { stdout: "", code: 7, stderr: "rg: broken" });

    const res = await app.inject({ url: "/api/projects/demo/search?q=hello" });

    expect(res.statusCode).toBe(500);
  });
});
