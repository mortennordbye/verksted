import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { GitBranches } from "../../shared/api.js";

let app: FastifyInstance;
let reposDir: string;
let remoteDir: string;

function run(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
  });
}

const repo = () => path.join(reposDir, "demo");

/** Commit a file straight into the bare remote, via a throwaway clone. */
function commitOnRemote(name: string, branch = "main") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vk-push-"));
  execFileSync("git", ["clone", "-b", branch, remoteDir, tmp], { stdio: "pipe" });
  fs.writeFileSync(path.join(tmp, name), name);
  run(tmp, "add", "-A");
  run(tmp, "commit", "-m", name);
  run(tmp, "push", "origin", branch);
  fs.rmSync(tmp, { recursive: true, force: true });
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-branch-"));
  remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-remote-"));
  execFileSync("git", ["init", "--bare", "-b", "main", remoteDir], { stdio: "pipe" });

  const seed = fs.mkdtempSync(path.join(os.tmpdir(), "vk-seed-"));
  execFileSync("git", ["init", "-b", "main", seed], { stdio: "pipe" });
  fs.writeFileSync(path.join(seed, "a.txt"), "hello");
  run(seed, "add", "-A");
  run(seed, "commit", "-m", "init");
  run(seed, "branch", "feature");
  run(seed, "remote", "add", "origin", remoteDir);
  run(seed, "push", "-u", "origin", "main");
  run(seed, "push", "origin", "feature");
  fs.rmSync(seed, { recursive: true, force: true });

  execFileSync("git", ["clone", remoteDir, repo()], { stdio: "pipe" });

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/projects/:name/git/branches", () => {
  it("lists local and remote branches with the upstream", async () => {
    const res = await app.inject({ url: "/api/projects/demo/git/branches" });
    expect(res.statusCode).toBe(200);
    const body = res.json<GitBranches>();
    expect(body.current).toBe("main");
    expect(body.local).toEqual(["main"]);
    expect(body.remote).toEqual(["origin/feature", "origin/main"]);
    expect(body.upstream).toBe("origin/main");
    expect(body.ahead).toBe(0);
    expect(body.behind).toBe(0);
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({ url: "/api/projects/ghost/git/branches" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/projects/:name/git/checkout", () => {
  it("switches to a remote-only branch by creating a tracking branch", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/checkout",
      payload: { branch: "feature" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branch: "feature" });

    const back = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/checkout",
      payload: { branch: "main" },
    });
    expect(back.statusCode).toBe(200);
  });

  it("rejects an invalid branch name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/checkout",
      payload: { branch: "bad branch" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409s a branch that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/checkout",
      payload: { branch: "nope" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("POST /api/projects/:name/git/pull", () => {
  it("fast-forwards to the remote", async () => {
    commitOnRemote("remote1.txt");
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/pull" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(repo(), "remote1.txt"))).toBe(true);
  });

  it("409s a diverged branch instead of merging", async () => {
    commitOnRemote("remote2.txt");
    fs.writeFileSync(path.join(repo(), "local.txt"), "local");
    run(repo(), "add", "-A");
    run(repo(), "commit", "-m", "local");
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/pull" });
    expect(res.statusCode).toBe(409);
    expect(fs.existsSync(path.join(repo(), "remote2.txt"))).toBe(false);
  });
});

describe("POST /api/projects/:name/git/reset", () => {
  it("drops local commits and matches the upstream", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/reset" });
    expect(res.statusCode).toBe(200);
    expect(fs.existsSync(path.join(repo(), "remote2.txt"))).toBe(true);
    expect(fs.existsSync(path.join(repo(), "local.txt"))).toBe(false);
  });
});

describe("POST /api/projects/:name/git/push", () => {
  const branches = async () =>
    (await app.inject({ url: "/api/projects/demo/git/branches" })).json<GitBranches>();
  const remoteHead = (branch: string) =>
    execFileSync("git", ["-C", remoteDir, "rev-parse", branch], { encoding: "utf8" }).trim();
  const localHead = () =>
    execFileSync("git", ["-C", repo(), "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

  it("publishes a branch that tracks nothing, and sets its upstream", async () => {
    run(repo(), "switch", "-c", "topic");
    fs.writeFileSync(path.join(repo(), "topic.txt"), "topic");
    run(repo(), "add", "-A");
    run(repo(), "commit", "-m", "topic");
    expect((await branches()).upstream).toBeNull();
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/push" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ branch: "topic", upstream: "origin/topic" });
    expect(remoteHead("topic")).toBe(localHead());
  });

  it("counts what is ahead, and pushes it", async () => {
    fs.writeFileSync(path.join(repo(), "topic2.txt"), "more");
    run(repo(), "add", "-A");
    run(repo(), "commit", "-m", "more");
    expect(await branches()).toMatchObject({ upstream: "origin/topic", ahead: 1, behind: 0 });
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/push" });
    expect(res.statusCode).toBe(200);
    expect(remoteHead("topic")).toBe(localHead());
    expect((await branches()).ahead).toBe(0);
  });

  it("409s a push the remote rejects rather than forcing it", async () => {
    commitOnRemote("elsewhere.txt", "topic");
    fs.writeFileSync(path.join(repo(), "topic3.txt"), "local");
    run(repo(), "add", "-A");
    run(repo(), "commit", "-m", "local");
    const before = remoteHead("topic");
    const res = await app.inject({ method: "POST", url: "/api/projects/demo/git/push" });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "rejected by the remote — pull first, or force push" });
    expect(remoteHead("topic")).toBe(before);
    // Nothing fetched, so the tracking ref has not moved: still 1 ahead, 0 behind.
    expect(await branches()).toMatchObject({ ahead: 1, behind: 0 });
  });

  it("will not force over commits this repo has not fetched", async () => {
    const before = remoteHead("topic");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/push",
      payload: { force: true },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/not fetched/);
    expect(remoteHead("topic")).toBe(before);
  });

  it("force pushes over what was fetched", async () => {
    run(repo(), "fetch", "origin");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/push",
      payload: { force: true },
    });
    expect(res.statusCode).toBe(200);
    expect(remoteHead("topic")).toBe(localHead());
    run(repo(), "switch", "main");
  });

  it("rejects a body with anything but force", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/demo/git/push",
      payload: { force: "yes" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("submodules", () => {
  // A pull that moves a submodule used to leave its checkout behind, and the
  // repo then read as dirty with nothing changed by anyone.
  let sub: string;
  let parent: string;
  let clone: string;
  const status = (dir: string) =>
    execFileSync("git", ["-C", dir, "status", "--porcelain"], { encoding: "utf8" }).trim();

  beforeAll(() => {
    sub = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sub-"));
    execFileSync("git", ["init", "-b", "main", sub], { stdio: "pipe" });
    fs.writeFileSync(path.join(sub, "s.txt"), "one");
    run(sub, "add", "-A");
    run(sub, "commit", "-m", "one");

    parent = fs.mkdtempSync(path.join(os.tmpdir(), "vk-parent-"));
    execFileSync("git", ["init", "--bare", "-b", "main", parent], { stdio: "pipe" });
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "vk-pseed-"));
    execFileSync("git", ["clone", parent, seed], { stdio: "pipe" });
    run(seed, "-c", "protocol.file.allow=always", "submodule", "add", sub, "theme");
    run(seed, "commit", "-m", "add theme");
    run(seed, "push", "origin", "main");

    clone = path.join(reposDir, "withsub");
    execFileSync(
      "git",
      ["-c", "protocol.file.allow=always", "clone", "--recurse-submodules", parent, clone],
      {
        stdio: "pipe",
      },
    );

    // Move the submodule forward upstream.
    fs.writeFileSync(path.join(sub, "s.txt"), "two");
    run(sub, "commit", "-am", "two");
    run(path.join(seed, "theme"), "pull", "origin", "main");
    run(seed, "commit", "-am", "bump theme");
    run(seed, "push", "origin", "main");
    fs.rmSync(seed, { recursive: true, force: true });
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_0 = "always";
  });

  afterAll(() => {
    delete process.env.GIT_CONFIG_COUNT;
    delete process.env.GIT_CONFIG_KEY_0;
    delete process.env.GIT_CONFIG_VALUE_0;
  });

  it("brings the submodule along on a pull, leaving the repo clean", async () => {
    const res = await app.inject({ method: "POST", url: "/api/projects/withsub/git/pull" });
    expect(res.statusCode).toBe(200);
    expect(status(clone)).toBe("");
    expect(fs.readFileSync(path.join(clone, "theme", "s.txt"), "utf8")).toBe("two");
  });

  it("puts a drifted submodule back on reset", async () => {
    run(path.join(clone, "theme"), "checkout", "-q", "HEAD~1");
    expect(status(clone)).not.toBe("");
    const res = await app.inject({ method: "POST", url: "/api/projects/withsub/git/reset" });
    expect(res.statusCode).toBe(200);
    expect(status(clone)).toBe("");
  });
});

describe("syncDefaultBranch", () => {
  it("switches to the default branch and pulls", async () => {
    const { syncDefaultBranch } = await import("../src/git.js");
    run(repo(), "switch", "feature");
    commitOnRemote("remote3.txt");
    expect(await syncDefaultBranch(repo())).toEqual({ branch: "main", status: "synced" });
    expect(fs.existsSync(path.join(repo(), "remote3.txt"))).toBe(true);
  });

  it("leaves a dirty tree alone", async () => {
    const { syncDefaultBranch } = await import("../src/git.js");
    run(repo(), "switch", "feature");
    fs.writeFileSync(path.join(repo(), "a.txt"), "changed");
    const sync = await syncDefaultBranch(repo());
    expect(sync).toEqual({
      branch: "feature",
      status: "skipped",
      detail: "uncommitted changes",
    });
    run(repo(), "restore", "a.txt");
    run(repo(), "switch", "main");
  });

  it("leaves a linked worktree on its own branch", async () => {
    const { syncDefaultBranch } = await import("../src/git.js");
    const wt = path.join(reposDir, "demo--feature");
    run(repo(), "worktree", "add", wt, "feature");
    expect(await syncDefaultBranch(wt)).toEqual({
      branch: "feature",
      status: "skipped",
      detail: "linked worktree of demo",
    });
  });
});

describe("workSince", () => {
  // Its own clone, so committing here cannot disturb the shared repo the
  // describes above check out and reset.
  let dir: string;
  let start: string;

  beforeAll(async () => {
    dir = path.join(reposDir, "work");
    execFileSync("git", ["clone", remoteDir, dir], { stdio: "pipe" });
    const { headCommit } = await import("../src/git.js");
    start = (await headCommit(dir))!;
  });

  function commit(name: string, body = name) {
    fs.writeFileSync(path.join(dir, name), body);
    run(dir, "add", "-A");
    run(dir, "commit", "-m", name);
  }

  it("has nothing to report on a session that changed nothing", async () => {
    const { workSince } = await import("../src/git.js");
    expect(await workSince(dir, start)).toEqual({
      commits: 0,
      files: 0,
      dirty: 0,
      unpushed: 0,
      branch: "main",
    });
  });

  it("counts the commits, the files they touched, and what no remote has", async () => {
    const { workSince } = await import("../src/git.js");
    commit("b.txt");
    commit("c.txt");
    // A second commit to a file already counted: the run touched two files, not
    // three, which is what a "3 commits, 2 files" row is claiming.
    commit("b.txt", "again");

    const work = await workSince(dir, start);

    expect(work).toEqual({ commits: 3, files: 2, dirty: 0, unpushed: 3, branch: "main" });
  });

  it("counts what was left uncommitted separately from what was committed", async () => {
    const { workSince } = await import("../src/git.js");
    fs.writeFileSync(path.join(dir, "d.txt"), "not staged");
    fs.writeFileSync(path.join(dir, "a.txt"), "modified");

    const work = await workSince(dir, start);

    expect(work!.dirty).toBe(2);
    expect(work!.commits).toBe(3);
    run(dir, "restore", "a.txt");
    fs.rmSync(path.join(dir, "d.txt"));
  });

  it("stops counting as unpushed once the branch is pushed", async () => {
    const { workSince } = await import("../src/git.js");
    run(dir, "push", "origin", "main");

    expect((await workSince(dir, start))!.unpushed).toBe(0);
  });

  it("says nothing at all rather than zero when it cannot measure", async () => {
    // A commit no longer reachable — the branch was reset, or the session ended
    // somewhere with no path back. "0 commits" would be a claim, not an answer.
    const { workSince } = await import("../src/git.js");
    expect(await workSince(dir, "0".repeat(40))).toBeNull();
  });

  it("has no upstream to compare against on a branch that was never pushed", async () => {
    const { workSince } = await import("../src/git.js");
    run(dir, "switch", "-c", "local-only");
    commit("e.txt");

    const work = await workSince(dir, start);

    expect(work!.unpushed).toBeNull();
    expect(work!.branch).toBe("local-only");
    run(dir, "switch", "main");
  });
});
