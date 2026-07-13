import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let reposDir: string;
let sessionsDir: string;

function meta(id: string, project: string) {
  return JSON.stringify({
    id,
    project,
    agent: "claude",
    title: "t",
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  });
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-proj-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  fs.writeFileSync(path.join(reposDir, "demo", "a.txt"), "hello");
  fs.mkdirSync(path.join(reposDir, "other"));
  fs.writeFileSync(path.join(sessionsDir, "vk-demo-1.json"), meta("vk-demo-1", "demo"));
  fs.writeFileSync(path.join(sessionsDir, "vk-other-1.json"), meta("vk-other-1", "other"));

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("DELETE /api/sessions/:id?purge=1", () => {
  it("removes the session from history", async () => {
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-2.json"), meta("vk-demo-2", "demo"));
    const res = await app.inject({ method: "DELETE", url: "/api/sessions/vk-demo-2?purge=1" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(sessionsDir, "vk-demo-2.json"))).toBe(false);
  });

  it("404s an unknown session", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/sessions/vk-ghost-9?purge=1" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:name/worktrees", () => {
  let repo: string;

  beforeAll(() => {
    repo = path.join(reposDir, "wt");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "a.txt"), "x");
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
    git("init", "-b", "main");
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  });

  it("creates a worktree project on a new branch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/wt/worktrees",
      payload: { branch: "feature-x" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: "wt--feature-x", branch: "feature-x" });
    const head = execFileSync(
      "git",
      ["-C", path.join(reposDir, "wt--feature-x"), "symbolic-ref", "--short", "HEAD"],
    ).toString().trim();
    expect(head).toBe("feature-x");
  });

  it("reports it in the project list as a worktree of its repo", async () => {
    const res = await app.inject({ url: "/api/projects" });
    const wt = res.json().find((p: { name: string }) => p.name === "wt--feature-x");
    expect(wt).toMatchObject({ branch: "feature-x", worktreeOf: "wt" });
    const main = res.json().find((p: { name: string }) => p.name === "wt");
    expect(main.worktreeOf).toBeNull();
  });

  it("409s when the branch is already checked out in another worktree", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/wt/worktrees",
      payload: { branch: "feature-x" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects invalid branch names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/wt/worktrees",
      payload: { branch: "-bad..name" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("deleting the worktree project unregisters it from the main repo", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/projects/wt--feature-x" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(reposDir, "wt--feature-x"))).toBe(false);
    const list = execFileSync("git", ["-C", repo, "worktree", "list", "--porcelain"]).toString();
    expect(list).not.toContain("wt--feature-x");
    // the branch itself survives in the main repo
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", "refs/heads/feature-x"]);
  });

  it("deleting the main repo deletes its worktree projects too", async () => {
    await app.inject({
      method: "POST",
      url: "/api/projects/wt/worktrees",
      payload: { branch: "feature-y" },
    });
    expect(fs.existsSync(path.join(reposDir, "wt--feature-y"))).toBe(true);
    const res = await app.inject({ method: "DELETE", url: "/api/projects/wt" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(reposDir, "wt"))).toBe(false);
    expect(fs.existsSync(path.join(reposDir, "wt--feature-y"))).toBe(false);
  });
});

describe("DELETE /api/projects/:name", () => {
  it("404s an unknown project", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/projects/ghost" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects traversal in the project name", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/projects/..%2Fother" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(fs.existsSync(path.join(reposDir, "other"))).toBe(true);
  });

  it("removes the repo directory and the project's session metadata", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/projects/demo" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ name: "demo" });
    expect(fs.existsSync(path.join(reposDir, "demo"))).toBe(false);
    expect(fs.existsSync(path.join(sessionsDir, "vk-demo-1.json"))).toBe(false);
    // Other projects and their metadata are untouched.
    expect(fs.existsSync(path.join(reposDir, "other"))).toBe(true);
    expect(fs.existsSync(path.join(sessionsDir, "vk-other-1.json"))).toBe(true);
  });
});
