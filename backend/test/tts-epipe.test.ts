import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * A voice that started and then stopped listening (A-32).
 *
 * The third pod, beside the one that works (tts.test.ts) and the one that will
 * not start (tts-crash.test.ts): the worker says it is ready and then closes
 * its end of the pipe while staying alive, which is what a python that has hit
 * an exception in its read loop looks like from here. Writing to that pipe is
 * EPIPE, delivered as an `error` event on stdin, and an `error` event nobody
 * listens for is the whole backend.
 */
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-epipe-"));
  const python = path.join(dir, "python");
  fs.writeFileSync(
    python,
    ["#!/bin/sh", `echo '{"voices":["af_sarah"]}'`, "exec 0<&-", "sleep 20", ""].join("\n"),
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, "say.py"), "");
  fs.writeFileSync(path.join(dir, "model.onnx"), "not really a model");
  fs.writeFileSync(path.join(dir, "voices.bin"), "not really voices");

  process.env.KOKORO_PYTHON = python;
  process.env.KOKORO_SCRIPT = path.join(dir, "say.py");
  process.env.KOKORO_MODEL = path.join(dir, "model.onnx");
  process.env.KOKORO_VOICES = path.join(dir, "voices.bin");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-epipe-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-epipe-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  const { stop } = await import("../src/tts.js");
  stop();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const speak = () =>
  app.inject({ method: "POST", url: "/api/assistant/speak", payload: { text: "Hello there." } });

describe("a voice that has stopped listening", () => {
  it("answers 502 rather than taking the backend down with it", async () => {
    const res = await speak();
    expect(res.statusCode).toBe(502);
    // Still here to be asked.
    expect((await app.inject({ url: "/api/health" })).statusCode).toBe(200);
  });

  it("does not wedge the queue for whoever asks next", async () => {
    const res = await speak();
    expect(res.statusCode).toBe(502);
  });
});
