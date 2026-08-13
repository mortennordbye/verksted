import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * `vk feedback`: a note from inside a session, filed as a feed item.
 *
 * The note has no store of its own — it is a bench item like a session that
 * stopped to ask, so what is pinned here is the route: the plain-text body a
 * shell script can send without quoting, the provenance read off the session
 * rather than the caller, and the one item per distinct complaint.
 */
let app: FastifyInstance;
let feedDir: string;
let sessionsDir: string;
let feed: typeof import("../src/feed-store.js");

beforeAll(async () => {
  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-fb-feed-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.FEED_DIR = feedDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.LOOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-loops-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  for (const f of fs.readdirSync(feedDir)) fs.rmSync(path.join(feedDir, f));
});

/** What `vk feedback` sends: the note as the whole body, no JSON in sight. */
const file = (text: string, query = "") =>
  app.inject({
    method: "POST",
    url: `/api/feedback${query}`,
    headers: { "content-type": "text/plain" },
    payload: text,
  });

const notes = async () => (await feed.list()).filter((i) => i.id.startsWith("bench:feedback:"));

describe("POST /api/feedback", () => {
  it("files a note as a bench item the inbox already knows how to show", async () => {
    const res = await file("the file tree cannot rename anything");
    expect(res.statusCode).toBe(201);
    expect(res.json().source).toBe("bench");
    expect(res.json().title).toContain("the file tree cannot rename anything");
    // Untriaged, like anything else a poller files: the assistant judges it.
    expect(res.json().triaged).toBe(false);
    expect(await notes()).toHaveLength(1);
  });

  /**
   * Every session is told about this command, so the same limitation met twice
   * is the normal case rather than the odd one. A queue that repeats itself is
   * a queue nobody reads to the bottom.
   */
  it("does not file the same note twice, and does not undo a dismissal", async () => {
    const first = await file("no way to rename a file");
    await feed.setState(first.json().id, "done");
    const second = await file("  no way to rename a file  ");
    expect(second.json().id).toBe(first.json().id);
    expect(second.json().state).toBe("done");
    expect(await notes()).toHaveLength(1);
  });

  it("refuses an empty note", async () => {
    expect((await file("   \n  ")).statusCode).toBe(400);
  });

  it("refuses a note longer than a note", async () => {
    expect((await file("x".repeat(1001))).statusCode).toBe(400);
  });

  it("says nothing about a session it does not know", async () => {
    const res = await file("something", "?session=vk-nope-9");
    expect(res.statusCode).toBe(201);
    expect(res.json().detail).toBe("something");
    expect(res.json().link).toBeNull();
  });

  /**
   * The session id is a claim, not proof — anything on the pod can post here.
   * It is used to look up facts verksted already holds, and for nothing else.
   */
  it("takes the repo and agent off the session rather than the caller", async () => {
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-1.json"),
      JSON.stringify({
        id: "vk-demo-1",
        project: "demo",
        agent: "codex",
        title: "t",
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
      }),
    );
    const res = await file("the browser pane cannot be resized", "?session=vk-demo-1");
    expect(res.json().detail).toContain("filed by codex in demo");
    expect(res.json().link).toBe("/s/vk-demo-1");
  });

  it("keeps a path out of the filename", async () => {
    await file("../../etc/passwd is not a note");
    expect(fs.readdirSync(feedDir).every((f) => /^bench_feedback_[0-9a-f]+\.json$/.test(f))).toBe(
      true,
    );
  });
});
