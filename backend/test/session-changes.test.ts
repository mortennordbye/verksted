import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type {
  Session,
  SessionChanges,
  SessionFileDiff,
  SessionPatch,
  SessionReview,
} from "../../shared/api.js";
import { parseNumstatZ } from "../src/git.js";

let app: FastifyInstance;
let reposDir: string;
let sessionsDir: string;
let first: string;
let second: string;

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function meta(id: string, extra: Record<string, unknown>) {
  return JSON.stringify({
    id,
    project: "demo",
    agent: "claude",
    title: "t",
    createdAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ...extra,
  });
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-chg-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-chg-sess-"));
  const repo = path.join(reposDir, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  first = git(repo, "rev-parse", "HEAD");
  // A non-ASCII path in the second commit: C-quoted output would make it a path
  // the per-file diff could not ask for, which is what -z parsing is here for.
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "æ.txt"), "hei\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "second commit");
  second = git(repo, "rev-parse", "HEAD");
  // Movement after the session ended: the pinned range must not include it.
  fs.writeFileSync(path.join(repo, "later.txt"), "after\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "later");

  fs.writeFileSync(
    path.join(sessionsDir, "vk-demo-1.json"),
    meta("vk-demo-1", { startCommit: first, endCommit: second }),
  );
  fs.writeFileSync(path.join(sessionsDir, "vk-demo-2.json"), meta("vk-demo-2", {}));
  fs.writeFileSync(
    path.join(sessionsDir, "vk-demo-3.json"),
    meta("vk-demo-3", { startCommit: "0".repeat(40), endCommit: second }),
  );

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fs.rmSync(reposDir, { recursive: true, force: true });
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

describe("GET /api/sessions/:id/changes", () => {
  it("reports the commits and files of the session's own range", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-1/changes" });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionChanges>();
    expect(body.from).toBe(first);
    expect(body.to).toBe(second);
    expect(body.commits.map((c) => c.subject)).toEqual(["second commit"]);
    expect(body.truncated).toBe(false);
    expect(body.files).toEqual(
      expect.arrayContaining([
        { path: "a.txt", added: 1, removed: 0, binary: false },
        { path: "æ.txt", added: 1, removed: 0, binary: false },
      ]),
    );
  });

  it("stops at the end commit, so later work is not attributed to it", async () => {
    const body = (
      await app.inject({ url: "/api/sessions/vk-demo-1/changes" })
    ).json<SessionChanges>();
    expect(body.files.map((f) => f.path)).not.toContain("later.txt");
  });

  it("answers with an empty range when the session has no start commit", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-2/changes" });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionChanges>()).toEqual({
      from: null,
      to: null,
      commits: [],
      files: [],
      truncated: false,
      review: { files: [], reviewed: 0, verdict: null },
    });
  });

  it("409s rather than reporting nothing when the range cannot be read", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-3/changes" });
    expect(res.statusCode).toBe(409);
  });

  it("404s an unknown session", async () => {
    expect((await app.inject({ url: "/api/sessions/vk-ghost-9/changes" })).statusCode).toBe(404);
  });
});

describe("GET /api/sessions/:id/changes/diff", () => {
  it("returns the file's diff over the range", async () => {
    const res = await app.inject({
      url: `/api/sessions/vk-demo-1/changes/diff?path=${encodeURIComponent("æ.txt")}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionFileDiff>();
    expect(body.path).toBe("æ.txt");
    expect(body.diff).toContain("+hei");
    expect(body.truncated).toBe(false);
  });

  it("is empty for a file the range did not touch", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-1/changes/diff?path=later.txt" });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionFileDiff>().diff).toBe("");
  });

  it("denies a path outside the repo", async () => {
    const res = await app.inject({
      url: "/api/sessions/vk-demo-1/changes/diff?path=" + encodeURIComponent("../../etc/passwd"),
    });
    expect(res.statusCode).toBe(403);
  });

  it("requires a path", async () => {
    expect((await app.inject({ url: "/api/sessions/vk-demo-1/changes/diff" })).statusCode).toBe(
      400,
    );
  });
});

describe("GET /api/sessions/:id/changes/patch", () => {
  it("returns the whole range as one patch", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-1/changes/patch" });
    expect(res.statusCode).toBe(200);
    const body = res.json<SessionPatch>();
    // Both files of the range, in one answer rather than one request each.
    expect(body.diff).toContain("+++ b/a.txt");
    expect(body.diff).toContain("+hei");
    expect(body.truncated).toBe(false);
  });

  it("spells a non-ASCII path the way the file list spells it", async () => {
    const body = (
      await app.inject({ url: "/api/sessions/vk-demo-1/changes/patch" })
    ).json<SessionPatch>();
    // C-quoted ("\303\246.txt") would match no row of the list it is read beside.
    expect(body.diff).toContain("+++ b/æ.txt");
  });

  it("stops at the end commit", async () => {
    const body = (
      await app.inject({ url: "/api/sessions/vk-demo-1/changes/patch" })
    ).json<SessionPatch>();
    expect(body.diff).not.toContain("later.txt");
  });

  it("is empty for a session with no range, rather than an error", async () => {
    const res = await app.inject({ url: "/api/sessions/vk-demo-2/changes/patch" });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionPatch>()).toEqual({ diff: "", truncated: false });
  });

  it("409s when the range cannot be read", async () => {
    expect((await app.inject({ url: "/api/sessions/vk-demo-3/changes/patch" })).statusCode).toBe(
      409,
    );
  });

  it("404s an unknown session", async () => {
    expect((await app.inject({ url: "/api/sessions/vk-ghost-9/changes/patch" })).statusCode).toBe(
      404,
    );
  });
});

describe("PATCH /api/sessions/:id/review", () => {
  const patch = (id: string, payload: Record<string, unknown>) =>
    app.inject({ method: "PATCH", url: `/api/sessions/${id}/review`, payload });

  it("marks a file read, and reports it back with the range", async () => {
    const res = await patch("vk-demo-1", { file: { path: "a.txt", read: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json<SessionReview>()).toEqual({
      files: ["a.txt"],
      reviewed: 1,
      verdict: null,
    });

    const changes = (
      await app.inject({ url: "/api/sessions/vk-demo-1/changes" })
    ).json<SessionChanges>();
    expect(changes.review.files).toEqual(["a.txt"]);
  });

  it("does not count the same file twice", async () => {
    await patch("vk-demo-1", { file: { path: "a.txt", read: true } });
    const body = (
      await patch("vk-demo-1", { file: { path: "a.txt", read: true } })
    ).json<SessionReview>();
    expect(body.files).toEqual(["a.txt"]);
  });

  it("keeps every mark when a burst of them arrives at once", async () => {
    // Ticking files off as fast as a thumb moves. Each write is
    // read-modify-write on one metadata file, so run concurrently the last to
    // finish used to win and the rest vanished.
    await Promise.all(
      ["one.ts", "two.ts", "three.ts", "four.ts"].map((p) =>
        patch("vk-demo-1", { file: { path: p, read: true } }),
      ),
    );
    const marked = ["one.ts", "two.ts", "three.ts", "four.ts"];
    const body = (await patch("vk-demo-1", {})).json<SessionReview>();
    expect(body.files).toEqual(expect.arrayContaining(marked));

    // Put the fixture back: the tests below are about what one review holds.
    for (const p of marked) await patch("vk-demo-1", { file: { path: p, read: false } });
  });

  it("takes a mark back", async () => {
    await patch("vk-demo-1", { file: { path: "æ.txt", read: true } });
    const body = (
      await patch("vk-demo-1", { file: { path: "æ.txt", read: false } })
    ).json<SessionReview>();
    expect(body.files).not.toContain("æ.txt");
  });

  it("records a verdict, and lets it be cleared", async () => {
    expect(
      (await patch("vk-demo-1", { verdict: "needs-work" })).json<SessionReview>().verdict,
    ).toBe("needs-work");
    expect((await patch("vk-demo-1", { verdict: null })).json<SessionReview>().verdict).toBe(null);
  });

  it("survives on the session, so it outlives the browser that set it", async () => {
    await patch("vk-demo-1", { verdict: "approved" });
    const meta = JSON.parse(fs.readFileSync(path.join(sessionsDir, "vk-demo-1.json"), "utf8"));
    expect(meta.verdict).toBe("approved");
    // And it reaches the lists a row is drawn from, as a count rather than paths.
    const session = (await app.inject({ url: "/api/sessions/vk-demo-1" })).json<Session>();
    expect(session.review).toEqual({ reviewed: 1, verdict: "approved" });
    expect(session).not.toHaveProperty("reviewed");
  });

  it("refuses a verdict it does not know", async () => {
    expect((await patch("vk-demo-1", { verdict: "lgtm" })).statusCode).toBe(400);
  });

  it("refuses a file entry without both halves", async () => {
    expect((await patch("vk-demo-1", { file: { path: "a.txt" } })).statusCode).toBe(400);
  });

  it("404s an unknown session", async () => {
    expect((await patch("vk-ghost-9", { verdict: "approved" })).statusCode).toBe(404);
  });
});

describe("parseNumstatZ", () => {
  it("reads an ordinary record", () => {
    expect(parseNumstatZ("12\t3\tsrc/a.ts\0")).toEqual([
      { path: "src/a.ts", added: 12, removed: 3, binary: false },
    ]);
  });

  it("reads a binary record", () => {
    expect(parseNumstatZ("-\t-\treal.bin\0")).toEqual([
      { path: "real.bin", added: 0, removed: 0, binary: true },
    ]);
  });

  it("takes the new name of a rename, whose own record has no path", () => {
    expect(parseNumstatZ("0\t0\t\0old.txt\0sub/new.txt\0" + "2\t1\tafter.txt\0")).toEqual([
      { path: "sub/new.txt", added: 0, removed: 0, binary: false },
      { path: "after.txt", added: 2, removed: 1, binary: false },
    ]);
  });
});
