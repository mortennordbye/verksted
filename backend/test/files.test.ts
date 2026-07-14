import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;

beforeAll(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vk-files-"));
  fs.mkdirSync(path.join(root, "demo", "sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo", "a.txt"), "hello");
  fs.writeFileSync(path.join(root, "demo", "sub", "b.txt"), "world");
  fs.writeFileSync(path.join(root, "demo", "bin.dat"), Buffer.from([1, 2, 0, 3]));
  fs.mkdirSync(path.join(root, "other"));
  fs.writeFileSync(path.join(root, "other", "secret.txt"), "s");

  // demo becomes a git repo on main with one modified + one untracked file.
  const demo = path.join(root, "demo");
  const git = (...args: string[]) => execFileSync("git", ["-C", demo, ...args]);
  git("init", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  fs.writeFileSync(path.join(demo, "sub", "b.txt"), "world changed");
  fs.writeFileSync(path.join(demo, "new.txt"), "untracked");

  // gitops: a repo with a commit, for exercising stage/unstage/commit.
  const gitops = path.join(root, "gitops");
  fs.mkdirSync(gitops);
  fs.writeFileSync(path.join(gitops, "base.txt"), "base");
  const g = (...args: string[]) => execFileSync("git", ["-C", gitops, ...args]);
  g("init", "-b", "main");
  g("add", "-A");
  g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init");
  fs.writeFileSync(path.join(gitops, "new.txt"), "brand new");

  // fresh: a repo with no commits yet (unstage must work without HEAD).
  const fresh = path.join(root, "fresh");
  fs.mkdirSync(fresh);
  fs.writeFileSync(path.join(fresh, "first.txt"), "x");
  execFileSync("git", ["-C", fresh, "init", "-b", "main"]);

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = root;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  // the commit endpoint reads the git identity from the process env
  process.env.GIT_AUTHOR_NAME = "t";
  process.env.GIT_AUTHOR_EMAIL = "t@t";
  process.env.GIT_COMMITTER_NAME = "t";
  process.env.GIT_COMMITTER_EMAIL = "t@t";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/projects/:name/tree", () => {
  it("returns the tree for a real project", async () => {
    const res = await app.inject({ url: "/api/projects/demo/tree" });
    expect(res.statusCode).toBe(200);
    const names = res.json().map((n: { name: string }) => n.name);
    expect(names).toContain("a.txt");
    expect(names).toContain("sub");
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({ url: "/api/projects/ghost/tree" });
    expect(res.statusCode).toBe(404);
  });

  it("rejects traversal in the project name", async () => {
    const res = await app.inject({ url: "/api/projects/..%2Fother/tree" });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe("GET /api/projects/:name/file", () => {
  it("reads a file inside the project", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=a.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "a.txt", content: "hello" });
  });

  it("denies .. traversal", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/file?path=${encodeURIComponent("../other/secret.txt")}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("secret");
  });

  it("denies absolute paths", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/file?path=${encodeURIComponent("/etc/passwd")}`,
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies directories", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=sub" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects binary files", async () => {
    const res = await app.inject({ url: "/api/projects/demo/file?path=bin.dat" });
    expect(res.statusCode).toBe(415);
  });
});

describe("GET /api/projects/:name/git", () => {
  it("returns branch and per-file statuses", async () => {
    const res = await app.inject({ url: "/api/projects/demo/git" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.branch).toBe("main");
    expect(body.files).toContainEqual({ path: "sub/b.txt", status: "M", staged: false });
    expect(body.files).toContainEqual({ path: "new.txt", status: "U", staged: false });
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({ url: "/api/projects/ghost/git" });
    expect(res.statusCode).toBe(404);
  });
});

describe("git stage / unstage / commit", () => {
  const gitFiles = async (project = "gitops") =>
    (await app.inject({ url: `/api/projects/${project}/git` })).json().files;

  const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });

  it("stages and unstages a file", async () => {
    let res = await post("/api/projects/gitops/git/stage", { paths: ["new.txt"] });
    expect(res.statusCode).toBe(200);
    expect(await gitFiles()).toContainEqual({ path: "new.txt", status: "A", staged: true });

    res = await post("/api/projects/gitops/git/unstage", { paths: ["new.txt"] });
    expect(res.statusCode).toBe(200);
    expect(await gitFiles()).toContainEqual({ path: "new.txt", status: "U", staged: false });
  });

  it("lists a partially staged file once per side", async () => {
    const base = path.join(process.env.REPOS_DIR!, "gitops", "base.txt");
    fs.writeFileSync(base, "staged half");
    await post("/api/projects/gitops/git/stage", { paths: ["base.txt"] });
    fs.writeFileSync(base, "staged half + unstaged half");
    const files = await gitFiles();
    expect(files).toContainEqual({ path: "base.txt", status: "M", staged: true });
    expect(files).toContainEqual({ path: "base.txt", status: "M", staged: false });
  });

  it("commits the staged files only", async () => {
    await post("/api/projects/gitops/git/stage", { paths: ["new.txt"] });
    const res = await post("/api/projects/gitops/git/commit", { message: "add new.txt" });
    expect(res.statusCode).toBe(200);
    const gitops = path.join(process.env.REPOS_DIR!, "gitops");
    const log = execFileSync("git", ["-C", gitops, "log", "-1", "--format=%s"]).toString().trim();
    expect(log).toBe("add new.txt");
    // the unstaged half of base.txt survives the commit
    const files = await gitFiles();
    expect(files.filter((f: { path: string }) => f.path === "new.txt")).toEqual([]);
    expect(files).toContainEqual({ path: "base.txt", status: "M", staged: false });
  });

  it("409s a commit with nothing staged", async () => {
    // gitops: tracked-but-unstaged changes; fresh: untracked files only —
    // git words the two "nothing staged" cases differently.
    let res = await post("/api/projects/gitops/git/commit", { message: "empty" });
    expect(res.statusCode).toBe(409);
    res = await post("/api/projects/fresh/git/commit", { message: "empty" });
    expect(res.statusCode).toBe(409);
  });

  it("unstages in a repo with no commits yet", async () => {
    let res = await post("/api/projects/fresh/git/stage", { paths: ["first.txt"] });
    expect(res.statusCode).toBe(200);
    expect(await gitFiles("fresh")).toContainEqual({ path: "first.txt", status: "A", staged: true });
    res = await post("/api/projects/fresh/git/unstage", { paths: ["first.txt"] });
    expect(res.statusCode).toBe(200);
    expect(await gitFiles("fresh")).toContainEqual({ path: "first.txt", status: "U", staged: false });
  });

  it("denies .. traversal in stage paths", async () => {
    const res = await post("/api/projects/gitops/git/stage", {
      paths: ["../other/secret.txt"],
    });
    expect(res.statusCode).toBe(403);
  });

  it("denies absolute stage paths", async () => {
    const res = await post("/api/projects/gitops/git/stage", { paths: ["/etc/passwd"] });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown project", async () => {
    const res = await post("/api/projects/ghost/git/commit", { message: "x" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/projects/:name/diff", () => {
  it("shows the unstaged diff of a modified file", async () => {
    const res = await app.inject({ url: "/api/projects/demo/diff?path=sub%2Fb.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().diff).toContain("-world");
    expect(res.json().diff).toContain("+world changed");
  });

  it("fabricates a new-file diff for untracked files", async () => {
    const res = await app.inject({ url: "/api/projects/demo/diff?path=new.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json().diff).toContain("+untracked");
  });

  it("shows the staged diff with staged=true", async () => {
    const gitops = path.join(process.env.REPOS_DIR!, "gitops");
    fs.appendFileSync(path.join(gitops, "base.txt"), " plus staged bit");
    execFileSync("git", ["-C", gitops, "add", "base.txt"]);
    const res = await app.inject({ url: "/api/projects/gitops/diff?path=base.txt&staged=true" });
    expect(res.json().diff).toContain("plus staged bit");
    execFileSync("git", ["-C", gitops, "restore", "--staged", "--worktree", "base.txt"]);
  });

  it("denies traversal", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/diff?path=${encodeURIComponent("../other/secret.txt")}`,
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/projects/:name/raw", () => {
  it("serves binary bytes with a safe content type", async () => {
    const res = await app.inject({ url: "/api/projects/demo/raw?path=bin.dat" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.rawPayload).toEqual(Buffer.from([1, 2, 0, 3]));
  });

  it("marks downloads as attachments", async () => {
    const res = await app.inject({ url: "/api/projects/demo/raw?path=a.txt&download=1" });
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("denies traversal", async () => {
    const res = await app.inject({
      url: `/api/projects/demo/raw?path=${encodeURIComponent("../other/secret.txt")}`,
    });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain("secret");
  });
});

describe("PUT /api/projects/:name/file", () => {
  const put = (project: string, p: string, body: Buffer) =>
    app.inject({
      method: "PUT",
      url: `/api/projects/${project}/file?path=${encodeURIComponent(p)}`,
      headers: { "content-type": "application/octet-stream" },
      payload: body,
    });

  it("writes the uploaded bytes", async () => {
    const res = await put("demo", "upload.bin", Buffer.from([9, 8, 0, 7]));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ path: "upload.bin", bytes: 4 });
    const disk = fs.readFileSync(path.join(process.env.REPOS_DIR!, "demo", "upload.bin"));
    expect(disk).toEqual(Buffer.from([9, 8, 0, 7]));
  });

  it("denies traversal", async () => {
    const res = await put("demo", "../other/evil.txt", Buffer.from("x"));
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(process.env.REPOS_DIR!, "other", "evil.txt"))).toBe(false);
  });

  it("denies absolute paths", async () => {
    const res = await put("demo", "/tmp/evil.txt", Buffer.from("x"));
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/projects/:name/git/discard", () => {
  const post = (url: string, payload: object) => app.inject({ method: "POST", url, payload });

  it("restores tracked files and deletes untracked ones", async () => {
    const gitops = path.join(process.env.REPOS_DIR!, "gitops");
    // state from the suite above: base.txt is tracked with unstaged changes
    fs.writeFileSync(path.join(gitops, "junk.txt"), "junk");
    const res = await post("/api/projects/gitops/git/discard", {
      paths: ["base.txt", "junk.txt"],
    });
    expect(res.statusCode).toBe(200);
    expect(fs.readFileSync(path.join(gitops, "base.txt"), "utf8")).toBe("staged half");
    expect(fs.existsSync(path.join(gitops, "junk.txt"))).toBe(false);
    const files = (await app.inject({ url: "/api/projects/gitops/git" })).json().files;
    expect(files).toEqual([]);
  });

  it("denies .. traversal", async () => {
    const res = await post("/api/projects/gitops/git/discard", { paths: ["../demo/a.txt"] });
    expect(res.statusCode).toBe(403);
    expect(fs.existsSync(path.join(process.env.REPOS_DIR!, "demo", "a.txt"))).toBe(true);
  });
});

describe("GET /api/projects/:name/search", () => {
  it("finds matches with path and line number", async () => {
    const res = await app.inject({ url: "/api/projects/demo/search?q=hello" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toContainEqual({ path: "a.txt", line: 1, text: "hello" });
  });

  it("returns [] when nothing matches", async () => {
    const res = await app.inject({ url: "/api/projects/demo/search?q=zzz-not-there" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("404s an unknown project", async () => {
    const res = await app.inject({ url: "/api/projects/ghost/search?q=x" });
    expect(res.statusCode).toBe(404);
  });

  it("is case-insensitive by default, sensitive with case=true", async () => {
    let res = await app.inject({ url: "/api/projects/demo/search?q=HELLO" });
    expect(res.json()).toHaveLength(1);
    res = await app.inject({ url: "/api/projects/demo/search?q=HELLO&case=true" });
    expect(res.json()).toEqual([]);
  });

  it("matches whole words with word=true", async () => {
    let res = await app.inject({ url: "/api/projects/demo/search?q=hell&word=true" });
    expect(res.json()).toEqual([]);
    res = await app.inject({ url: "/api/projects/demo/search?q=hello&word=true" });
    expect(res.json()).toHaveLength(1);
  });

  it("supports regex with regex=true and 400s a bad pattern", async () => {
    let res = await app.inject({ url: `/api/projects/demo/search?q=${encodeURIComponent("hel+o")}&regex=true` });
    expect(res.json()).toHaveLength(1);
    res = await app.inject({ url: `/api/projects/demo/search?q=${encodeURIComponent("[")}&regex=true` });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/projects/:name/replace", () => {
  const post = (payload: object, project = "demo") =>
    app.inject({ method: "POST", url: `/api/projects/${project}/replace`, payload });
  const demoFile = (name: string) => path.join(process.env.REPOS_DIR!, "demo", name);

  it("replaces literal matches and reports counts", async () => {
    fs.writeFileSync(demoFile("repl.txt"), "foo bar foo baz");
    const res = await post({ q: "foo", replace: "qux" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ files: 1, replacements: 2 });
    expect(fs.readFileSync(demoFile("repl.txt"), "utf8")).toBe("qux bar qux baz");
  });

  it("keeps '$' literal in non-regex replacements", async () => {
    fs.writeFileSync(demoFile("repl.txt"), "price");
    const res = await post({ q: "price", replace: "$&cost" });
    expect(res.json()).toEqual({ files: 1, replacements: 1 });
    expect(fs.readFileSync(demoFile("repl.txt"), "utf8")).toBe("$&cost");
  });

  it("supports regex backreferences", async () => {
    fs.writeFileSync(demoFile("repl.txt"), "a1 b2");
    const res = await post({ q: "([a-z])(\\d)", replace: "$2$1", regex: true });
    expect(res.json()).toEqual({ files: 1, replacements: 2 });
    expect(fs.readFileSync(demoFile("repl.txt"), "utf8")).toBe("1a 2b");
  });

  it("reports zero when nothing matches", async () => {
    const res = await post({ q: "zzz-not-there", replace: "x" });
    expect(res.json()).toEqual({ files: 0, replacements: 0 });
  });

  it("404s an unknown project", async () => {
    const res = await post({ q: "x", replace: "y" }, "ghost");
    expect(res.statusCode).toBe(404);
  });
});
