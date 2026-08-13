import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let feedbackDir: string;
let sessionsDir: string;

beforeAll(async () => {
  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  feedbackDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-fb-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.FEEDBACK_DIR = feedbackDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  for (const f of fs.readdirSync(feedbackDir)) fs.rmSync(path.join(feedbackDir, f));
});

/** What `vk feedback` sends: the note as the whole body, no JSON in sight. */
const file = (text: string, query = "") =>
  app.inject({
    method: "POST",
    url: `/api/feedback${query}`,
    headers: { "content-type": "text/plain" },
    payload: text,
  });

describe("POST /api/feedback", () => {
  it("files a note and hands it back with an id", async () => {
    const res = await file("the file tree cannot rename anything");
    expect(res.statusCode).toBe(201);
    expect(res.json().text).toBe("the file tree cannot rename anything");
    expect(res.json().id).toMatch(/^fb-[0-9a-f]{8}$/);

    const list = await app.inject({ url: "/api/feedback" });
    expect(list.json().feedback).toHaveLength(1);
  });

  /**
   * Every session is told about this command, so the same limitation met twice
   * is the normal case rather than the odd one. A queue that repeats itself is
   * a queue nobody reads to the bottom.
   */
  it("does not file the same note twice", async () => {
    const first = await file("no way to rename a file");
    const second = await file("  no way to rename a file  ");
    expect(second.json().id).toBe(first.json().id);
    expect((await app.inject({ url: "/api/feedback" })).json().feedback).toHaveLength(1);
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
    expect(res.json().session).toBeNull();
    expect(res.json().project).toBeNull();
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
    expect(res.json()).toMatchObject({ session: "vk-demo-1", project: "demo", agent: "codex" });
  });

  it("keeps a path out of the filename", async () => {
    const res = await file("something");
    expect(fs.readdirSync(feedbackDir)).toEqual([`${res.json().id}.json`]);
  });
});

describe("DELETE /api/feedback/:id", () => {
  it("drops a note that has been read", async () => {
    const { id } = (await file("something")).json();
    expect((await app.inject({ method: "DELETE", url: `/api/feedback/${id}` })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ url: "/api/feedback" })).json().feedback).toEqual([]);
  });

  it("404s on an id that is not one", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/feedback/..%2f..%2fetc" });
    expect(res.statusCode).toBe(404);
  });
});
