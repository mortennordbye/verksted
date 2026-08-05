import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

// This covers everything that stops before gh runs: the path boundary, the
// param schemas, and the answer a project with no GitHub remote gets. What
// happens once gh does run — the argv it is given, its output becoming the wire
// shape, its failures becoming statuses — is in github-gh.test.ts, against a
// fake gh on PATH. The output parsing helpers are unit-tested against captured
// fixtures in gh.test.ts.

let app: FastifyInstance;
let reposDir: string;

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-github-"));
  const local = path.join(reposDir, "local");
  execFileSync("git", ["init", "-b", "main", local], { stdio: "pipe" });
  fs.writeFileSync(path.join(local, "a.txt"), "hello");
  execFileSync("git", ["-C", local, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], {
    stdio: "pipe",
  });
  execFileSync(
    "git",
    ["-C", local, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
    { stdio: "pipe" },
  );

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

const paths = [
  "/api/projects/local/prs",
  "/api/projects/local/prs/1",
  "/api/projects/local/prs/1/diff",
  "/api/projects/local/runs",
  "/api/projects/local/runs/1",
  "/api/projects/local/runs/1/log",
];

describe("github routes: unknown project", () => {
  for (const p of paths) {
    it(`404s on ${p.replace("/local/", "/nope/")}`, async () => {
      const res = await app.inject({ url: p.replace("/local/", "/nope/") });
      expect(res.statusCode).toBe(404);
    });
  }

  it("404s a project name that escapes REPOS_DIR", async () => {
    const res = await app.inject({ url: "/api/projects/..%2F..%2Fetc/prs" });
    expect(res.statusCode).toBe(404);
  });
});

describe("github routes: param validation", () => {
  for (const bad of ["abc", "1;rm%20-rf", "-1", "12345678"]) {
    it(`rejects PR number "${bad}"`, async () => {
      const res = await app.inject({ url: `/api/projects/local/prs/${bad}` });
      expect(res.statusCode).toBe(400);
    });
  }

  it("rejects a non-numeric run id", async () => {
    const res = await app.inject({ url: "/api/projects/local/runs/abc/log" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await app.inject({ url: "/api/projects/local/prs?limit=99" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown state filter", async () => {
    const res = await app.inject({ url: "/api/projects/local/prs?state=merged" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a create body with no title", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/local/prs",
      payload: { body: "no title" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("github routes: a project with no GitHub remote", () => {
  // 409 rather than 5xx is the contract: nothing here is a server fault, it is
  // all something the user can fix. Which of the two messages comes back
  // depends on whether gh finds a token first — CI has none, the pod does.
  const FIXABLE = /no GitHub remote in this project|GH_TOKEN in settings/;

  for (const p of paths) {
    it(`explains itself on ${p}`, async () => {
      const res = await app.inject({ url: p });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(FIXABLE);
    });
  }

  it("refuses to open a PR from the default branch before touching the network", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/local/prs",
      payload: { title: "nope" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already on main/);
  });
});
