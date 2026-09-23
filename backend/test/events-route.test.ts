import fs from "node:fs";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The event stream over real HTTP rather than through inject, because what is
 * worth asserting about it only exists on a socket: the headers that make a
 * browser treat it as a stream, and the fact that holding one open does not
 * stop the process shutting down.
 */
let app: FastifyInstance;
let base: string;
let sessionsDir: string;

beforeAll(async () => {
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ev-sess-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ev-repos-"));
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ev-sched-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  fs.rmSync(sessionsDir, { recursive: true, force: true });
});

// Before the stream tests below: the last of them closes the app.
describe("GET /api/sessions/:id/chat/events (backlog: the chat view is pushed)", () => {
  it("says the transcript changed within about a second of it changing", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-ev-home-"));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const repo = path.join(process.env.REPOS_DIR!, "demo");
      fs.mkdirSync(repo, { recursive: true });
      const conv = "34343434-3434-4434-8434-343434343434";
      fs.writeFileSync(
        path.join(sessionsDir, "vk-demo-1.json"),
        JSON.stringify({
          id: "vk-demo-1",
          project: "demo",
          agent: "claude",
          title: "t",
          createdAt: new Date().toISOString(),
          endedAt: null,
        }),
      );
      fs.writeFileSync(path.join(sessionsDir, "vk-demo-1.conv"), conv);
      const dir = path.join(home, ".claude", "projects", fs.realpathSync(repo).replace(/\//g, "-"));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${conv}.jsonl`);
      fs.writeFileSync(file, "{}\n");

      const res = await fetch(`${base}/api/sessions/vk-demo-1/chat/events`, {
        signal: AbortSignal.timeout(6_000),
      });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      await reader.read(); // the hello
      setTimeout(() => fs.appendFileSync(file, "{}\n"), 300);
      let text = "";
      while (!text.includes("event: changed")) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
      expect(text).toContain("event: changed");
      await reader.cancel();
    } finally {
      process.env.HOME = realHome;
    }
  });

  it("404s a session that is not there", async () => {
    const res = await fetch(`${base}/api/sessions/vk-ghost-9/chat/events`);
    expect(res.status).toBe(404);
  });
});

describe("GET /api/events", () => {
  it("answers as an event stream a browser will not buffer", async () => {
    const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5_000) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    // The header that stops an intermediary holding the whole stream back.
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    await res.body?.cancel();
  });

  it("sends the answers as events, not as one body", async () => {
    const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5_000) });
    const reader = res.body!.getReader();
    let text = "";
    // Reads until both topics have come through, or the timeout aborts it.
    while (!text.includes("event: projects") || !text.includes("event: sessions")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    expect(text).toContain("event: sessions");
    expect(text).toContain("event: projects");
    expect(text).toMatch(/data: \[/);
    await reader.cancel();
  });

  /**
   * The keep-alive used to be a comment line, which EventSource never surfaces
   * — so a client had no way to tell "nothing has changed" from "this
   * connection is dead", and gave up on the stream seconds after every open.
   */
  it("says hello at once, as an event the client can hear", async () => {
    const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5_000) });
    const reader = res.body!.getReader();
    const { value } = await reader.read();

    expect(new TextDecoder().decode(value)).toContain("event: ping");
    await reader.cancel();
  });

  it("does not hold shutdown open", async () => {
    const res = await fetch(`${base}/api/events`, { signal: AbortSignal.timeout(5_000) });
    void res.body!.getReader().read();

    // close() waits for in-flight requests, and a stream never ends by itself:
    // unclosed, a pod restart sat here until the force-exit timer gave up.
    await expect(
      Promise.race([
        app.close(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("close hung")), 4_000)),
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("a client that is not reading (R-25)", () => {
  /** A socket whose far end has gone quiet: it takes bytes and never drains. */
  function stuck() {
    const written: string[] = [];
    let release: (() => void) | null = null;
    const res = new Writable({
      highWaterMark: 16 * 1024,
      write(chunk: Buffer, _enc, done) {
        written.push(chunk.toString());
        // Held until the test says the client has started reading again.
        release = done;
      },
    });
    return {
      res,
      written,
      drain: () => {
        const done = release;
        release = null;
        done?.();
      },
    };
  }

  it("keeps the newest frame per topic, not every frame it could not send", async () => {
    const { paced } = await import("../src/routes/events.js");
    const { res, written, drain } = stuck();
    const { send } = paced(res);
    const big = (n: number) => JSON.stringify({ n, pad: "x".repeat(100_000) });

    for (let n = 0; n < 50; n++) send("sessions", big(n));
    send("projects", "[1]");
    send("projects", "[2]");

    // Five megabytes were offered, and what is kept for it stays near the mark.
    expect(res.writableLength).toBeLessThan(600_000);

    // It comes back: what it gets is where things stand now.
    for (let i = 0; i < 20; i++) {
      drain();
      await new Promise((r) => setImmediate(r));
    }
    const all = written.join("");
    expect(all).toContain('"n":49');
    expect(all).not.toContain('"n":30');
    expect(all).toContain("data: [2]");
    expect(all).not.toContain("data: [1]");
  });

  it("holds the whole list rather than a change that needs the ones before it", async () => {
    const { paced } = await import("../src/routes/events.js");
    const { res, written, drain } = stuck();
    const { send } = paced(res);
    const big = JSON.stringify({ pad: "x".repeat(300_000) });
    send("projects", big);
    send("sessions-changed", '{"upsert":["a"]}', { event: "sessions", json: '["whole-1"]' });
    send("sessions-changed", '{"upsert":["b"]}', { event: "sessions", json: '["whole-2"]' });

    for (let i = 0; i < 10; i++) {
      drain();
      await new Promise((r) => setImmediate(r));
    }
    const all = written.join("");
    expect(all).toContain('event: sessions\ndata: ["whole-2"]');
    expect(all).not.toContain("sessions-changed");
  });
});
