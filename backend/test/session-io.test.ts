import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let sessionsDir: string;

/**
 * A real tmux session, so send-keys and capture-pane are exercised for real.
 *
 * Its own socket directory: vitest runs test files in parallel workers that
 * share a container, so a server on the default socket is shared with every
 * other suite — and a live session here would make another suite's "ended"
 * session look alive. The name is distinct for the same reason.
 */
const TMUX = "vk-sessionio-1";
const tmux = (...args: string[]) => execFileSync("tmux", args, { encoding: "utf8" });

function meta(id: string, project: string, endedAt: string | null = null) {
  return JSON.stringify({
    id,
    project,
    agent: "claude",
    title: `title-${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    endedAt,
  });
}

beforeAll(async () => {
  process.env.TMUX_TMPDIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tmux-"));
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  fs.mkdirSync(path.join(reposDir, "other"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  fs.writeFileSync(path.join(sessionsDir, `${TMUX}.json`), meta(TMUX, "demo"));
  fs.writeFileSync(path.join(sessionsDir, "vk-other-1.json"), meta("vk-other-1", "other"));
  fs.writeFileSync(
    path.join(sessionsDir, "vk-demo-2.json"),
    meta("vk-demo-2", "demo", "2026-01-02T00:00:00.000Z"),
  );

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  process.env.SETTINGS_FILE = path.join(sessionsDir, "settings.json");

  // A plain shell, so typed text is echoed back and can be captured.
  tmux("new-session", "-d", "-s", TMUX, "-x", "80", "-y", "24", "cat");

  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  try {
    tmux("kill-server");
  } catch {
    // already gone
  }
  await app.close();
});

describe("GET /api/sessions", () => {
  it("lists sessions across every project", async () => {
    const res = await app.inject({ url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    const projects = res.json().map((s: { project: string }) => s.project);
    expect(new Set(projects)).toEqual(new Set(["demo", "other"]));
  });

  it("still supports the per-project view", async () => {
    const res = await app.inject({ url: "/api/projects/demo/sessions" });
    const ids = res.json().map((s: { id: string }) => s.id);
    expect(ids).toContain(TMUX);
    expect(ids).not.toContain("vk-other-1");
  });
});

describe("POST /api/sessions/:id/input", () => {
  const send = (id: string, body: object) =>
    app.inject({ method: "POST", url: `/api/sessions/${id}/input`, payload: body });

  it("types text into the live pane", async () => {
    expect((await send(TMUX, { text: "hello from the queue" })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const out = (await app.inject({ url: `/api/sessions/${TMUX}/capture` })).json();
    expect(out.text).toContain("hello from the queue");
    expect(out.live).toBe(true);
  });

  // Without -l, tmux reads the text as key names: "Enter" would be a Return and
  // "C-c" would interrupt the agent rather than being typed.
  it("types key names literally rather than pressing them", async () => {
    await send(TMUX, { text: "literal Enter and C-c here", enter: true });
    await new Promise((r) => setTimeout(r, 300));
    const out = (await app.inject({ url: `/api/sessions/${TMUX}/capture` })).json();
    expect(out.text).toContain("literal Enter and C-c here");
  });

  // The other half of the rule above: a key has to have its own field, because
  // a literal sender cannot press anything and a non-literal one would press
  // half of what people type.
  it("presses a key rather than typing its name", async () => {
    expect((await send(TMUX, { key: "escape" })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const out = (await app.inject({ url: `/api/sessions/${TMUX}/capture` })).json();
    expect(out.text).not.toContain("escape");
    expect(out.text).not.toContain("Escape");
  });

  it("takes text or a key, but not a body with neither", async () => {
    expect((await send(TMUX, {})).statusCode).toBe(400);
    // Nothing outside the closed set can be pressed.
    expect((await send(TMUX, { key: "C-c" })).statusCode).toBe(400);
    expect((await send(TMUX, { key: "Enter" })).statusCode).toBe(400);
  });

  // How a question with several answers moves from ticking boxes to the screen
  // that submits them.
  it("presses right without typing it either", async () => {
    expect((await send(TMUX, { key: "right" })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 300));
    const out = (await app.inject({ url: `/api/sessions/${TMUX}/capture` })).json();
    expect(out.text).not.toContain("right");
    expect(out.text).not.toContain("Right");
  });

  it("404s an unknown session and 409s an ended one", async () => {
    expect((await send("vk-ghost-9", { text: "x" })).statusCode).toBe(404);
    expect((await send("vk-demo-2", { text: "x" })).statusCode).toBe(409);
  });

  it("rejects a missing or oversized text", async () => {
    expect((await send(TMUX, {})).statusCode).toBe(400);
    expect((await send(TMUX, { text: "x".repeat(10_001) })).statusCode).toBe(400);
  });

  // Fastify's ajv is configured with removeAdditional, so additionalProperties:
  // false strips an unknown key rather than rejecting the request. Asserting the
  // stripping is the accurate contract; asserting a 400 would be asserting a
  // behaviour this app does not have.
  it("says a working pane is not asking anything", async () => {
    const res = await app.inject({ url: `/api/sessions/${TMUX}/prompt` });
    expect(res.statusCode).toBe(200);
    // A pane running `cat` is the ordinary case this must not false-positive on.
    expect(res.json()).toEqual({ prompt: null });
  });

  it("says nothing is being asked by a session that has ended, and 404s a ghost", async () => {
    const ended = await app.inject({ url: "/api/sessions/vk-demo-2/prompt" });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toEqual({ prompt: null });
    expect((await app.inject({ url: "/api/sessions/vk-ghost-9/prompt" })).statusCode).toBe(404);
  });

  it("strips unknown body keys instead of failing", async () => {
    expect((await send(TMUX, { text: "kept", extra: 1 })).statusCode).toBe(200);
  });
});

describe("GET /api/sessions/:id/capture", () => {
  it("bounds the line count", async () => {
    expect((await app.inject({ url: `/api/sessions/${TMUX}/capture?lines=0` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: `/api/sessions/${TMUX}/capture?lines=501` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ url: `/api/sessions/${TMUX}/capture?lines=10` })).statusCode).toBe(
      200,
    );
  });

  it("reports an ended session as not live rather than failing", async () => {
    const out = (await app.inject({ url: "/api/sessions/vk-demo-2/capture" })).json();
    expect(out).toEqual({ id: "vk-demo-2", text: "", live: false });
  });

  it("404s an unknown session", async () => {
    expect((await app.inject({ url: "/api/sessions/vk-ghost-9/capture" })).statusCode).toBe(404);
  });

  // tmux pads every row to the pane width; on a phone that is mostly blanks.
  it("strips the trailing padding tmux adds", async () => {
    const out = (await app.inject({ url: `/api/sessions/${TMUX}/capture` })).json();
    expect(out.text).not.toMatch(/[ \t]+$/m);
  });
});
