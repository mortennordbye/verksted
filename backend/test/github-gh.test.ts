import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The gh-backed routes, driven by a fake gh on PATH.
 *
 * github.test.ts covers everything that stops before gh runs — the path
 * boundary, the param schemas, the no-remote answer. This covers what happens
 * once it does: the argv gh is actually given, how its output becomes the wire
 * shape, and how its failures become statuses. git stays real, so the merge
 * route's local-side guards are exercised rather than mocked.
 */
let app: FastifyInstance;
let fake: FakeBin;
let reposDir: string;

/** A repo with one commit, on main, with a GitHub remote. */
function repo(name: string): string {
  const dir = path.join(reposDir, name);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      stdio: "pipe",
    });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  git("add", "-A");
  git("commit", "-m", "init");
  git("remote", "add", "origin", "https://github.com/o/r.git");
  return dir;
}

const PR = {
  number: 7,
  title: "add the thing",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature-x",
  baseRefName: "main",
  author: { login: "morten" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://github.com/o/r/pull/7",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ],
  additions: 10,
  deletions: 2,
  changedFiles: 3,
};

beforeAll(async () => {
  fake = FakeBin.install(["gh"]);
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ghfake-"));
  for (const n of ["prs", "fail", "junk", "diff", "merge", "recover", "runs", "cache"]) repo(n);

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
});

describe("GET /api/projects/:name/prs", () => {
  it("asks gh for the fields it needs and maps the answer to the wire shape", async () => {
    fake.reply("gh", "pr list", { stdout: JSON.stringify([PR]) });

    const res = await app.inject({ url: "/api/projects/prs/prs?state=open&limit=5" });

    expect(res.statusCode).toBe(200);
    const [pr] = res.json();
    // The author object is flattened and the check rollup summarised — the two
    // shape changes the client depends on.
    expect(pr.author).toBe("morten");
    // One check failed, so the whole rollup collapses to the one word the row
    // shows.
    expect(pr.checks).toBe("failing");
    expect(pr.number).toBe(7);
    expect(pr.reviewDecision).toBe("APPROVED");

    const argv = fake.subcommand("gh", "pr")[0];
    expect(argv.slice(0, 6)).toEqual(["pr", "list", "--state", "open", "--limit", "5"]);
    // The requested fields travel as one comma-joined --json value.
    expect(argv[argv.indexOf("--json") + 1]).toContain("statusCheckRollup");
  });

  it("turns a missing token into the message that says where to fix it", async () => {
    fake.reply("gh", "pr list", {
      code: 4,
      stderr: "gh auth login required: no GH_TOKEN environment variable",
    });

    const res = await app.inject({ url: "/api/projects/fail/prs" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/GH_TOKEN in settings/);
  });

  it("answers 502 rather than crashing when gh prints something that is not JSON", async () => {
    fake.reply("gh", "pr list", { stdout: "Welcome to gh!\n" });

    const res = await app.inject({ url: "/api/projects/junk/prs" });

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe("unreadable gh output");
  });

  it("serves a repeat poll from the cache instead of spending a rate-limited call", async () => {
    fake.reply("gh", "pr list", { stdout: JSON.stringify([PR]) });

    await app.inject({ url: "/api/projects/cache/prs" });
    await app.inject({ url: "/api/projects/cache/prs" });

    expect(fake.subcommand("gh", "pr")).toHaveLength(1);
  });
});

describe("GET /api/projects/:name/prs/:number/diff", () => {
  it("truncates a diff too big to send, and says that it did", async () => {
    fake.reply("gh", "pr diff", { stdout: "x".repeat(500_000) });

    const res = await app.inject({ url: "/api/projects/diff/prs/7/diff" });

    expect(res.statusCode).toBe(200);
    expect(res.json().truncated).toBe(true);
    expect(res.json().diff).toHaveLength(400_000);
    expect(fake.subcommand("gh", "pr")[0]).toEqual(["pr", "diff", "7"]);
  });
});

describe("POST /api/projects/:name/prs/:number/merge", () => {
  it("squashes and deletes the branch", async () => {
    fake.reply("gh", "pr view", {
      stdout: JSON.stringify({ state: "OPEN", headRefName: "feature-x", mergeable: "MERGEABLE" }),
    });
    fake.reply("gh", "pr merge", { stdout: "" });

    const res = await app.inject({
      method: "POST",
      url: "/api/projects/merge/prs/7/merge",
    });

    expect(res.statusCode).toBe(200);
    expect(fake.subcommand("gh", "pr").find((a) => a[1] === "merge")).toEqual([
      "pr",
      "merge",
      "7",
      "--squash",
      "--delete-branch",
    ]);
  });

  it("refuses a PR that is not open, before asking GitHub to merge it", async () => {
    fake.reply("gh", "pr view", {
      stdout: JSON.stringify({ state: "CLOSED", headRefName: "feature-x", mergeable: "MERGEABLE" }),
    });

    const res = await app.inject({ method: "POST", url: "/api/projects/merge/prs/8/merge" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is closed/);
    expect(fake.subcommand("gh", "pr").some((a) => a[1] === "merge")).toBe(false);
  });

  it("refuses a PR with conflicts", async () => {
    fake.reply("gh", "pr view", {
      stdout: JSON.stringify({
        state: "OPEN",
        headRefName: "feature-x",
        mergeable: "CONFLICTING",
      }),
    });

    const res = await app.inject({ method: "POST", url: "/api/projects/merge/prs/9/merge" });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/conflicts/);
  });

  it("reports success when GitHub merged it and only gh's local cleanup failed", async () => {
    // The non-idempotent case: sending the user back to retry would have them
    // re-merge something that already landed.
    fake.reply("gh", "pr view 7 --json state,headRefName,mergeable", {
      stdout: JSON.stringify({ state: "OPEN", headRefName: "feature-x", mergeable: "MERGEABLE" }),
    });
    // The state-only re-check gh makes after the failure says it did land.
    fake.reply("gh", "pr view 7 --json state", { stdout: JSON.stringify({ state: "MERGED" }) });
    fake.reply("gh", "pr merge", { code: 1, stderr: "failed to delete local branch feature-x" });

    const res = await app.inject({ method: "POST", url: "/api/projects/recover/prs/7/merge" });

    expect(res.statusCode).toBe(200);
    expect(res.json().detail).toBeTruthy();
  });

  it("reports the failure when the merge really did not happen", async () => {
    fake.reply("gh", "pr view 7 --json state,headRefName,mergeable", {
      stdout: JSON.stringify({ state: "OPEN", headRefName: "feature-x", mergeable: "MERGEABLE" }),
    });
    fake.reply("gh", "pr view 7 --json state", { stdout: JSON.stringify({ state: "OPEN" }) });
    fake.reply("gh", "pr merge", { code: 1, stderr: "GraphQL: rate limit exceeded" });

    const res = await app.inject({ method: "POST", url: "/api/projects/recover/prs/7/merge" });

    expect(res.statusCode).toBe(429);
  });
});

describe("GET /api/projects/:name/runs", () => {
  it("maps a workflow run to the wire shape", async () => {
    fake.reply("gh", "run list", {
      stdout: JSON.stringify([
        {
          databaseId: 42,
          displayTitle: "fix the thing",
          workflowName: "ci",
          status: "completed",
          conclusion: "failure",
          event: "push",
          headBranch: "main",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:05:00Z",
          url: "https://github.com/o/r/actions/runs/42",
        },
      ]),
    });

    const res = await app.inject({ url: "/api/projects/runs/runs" });

    expect(res.statusCode).toBe(200);
    // databaseId/displayTitle/headBranch are gh's names, not the client's.
    expect(res.json()[0]).toMatchObject({
      id: 42,
      title: "fix the thing",
      workflow: "ci",
      branch: "main",
      conclusion: "failure",
    });
  });
});
