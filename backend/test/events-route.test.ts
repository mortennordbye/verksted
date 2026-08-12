import fs from "node:fs";
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
