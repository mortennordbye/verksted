import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * A voice that cannot start.
 *
 * Its own file because it needs a different pod to the one tts.test.ts
 * describes: there the four files are all present and the worker answers, here
 * the interpreter is there but will not run. `available()` only asks whether
 * the files exist, so this pod believes it has a voice right up until it tries
 * to use it — which is also what a bad image build, a half-mounted volume or a
 * broken venv look like from in here.
 *
 * What it guards is not the status code. A child process with no `error`
 * listener turns a failed spawn into an unhandled `error` event, and that is
 * the whole backend: the API, the scheduler and every attached terminal, taken
 * down because a phone asked for a sentence to be read aloud.
 */
let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-crash-"));
  const python = path.join(dir, "python");
  fs.writeFileSync(python, "#!/bin/sh\nexit 0\n");
  // Readable, so it exists; not executable, so exec fails with EACCES.
  fs.chmodSync(python, 0o644);
  fs.writeFileSync(path.join(dir, "say.py"), "");
  fs.writeFileSync(path.join(dir, "model.onnx"), "not really a model");
  fs.writeFileSync(path.join(dir, "voices.bin"), "not really voices");

  process.env.KOKORO_PYTHON = python;
  process.env.KOKORO_SCRIPT = path.join(dir, "say.py");
  process.env.KOKORO_MODEL = path.join(dir, "model.onnx");
  process.env.KOKORO_VOICES = path.join(dir, "voices.bin");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-crash-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-crash-sess-"));
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

describe("a pod whose voice will not start", () => {
  it("answers 502 rather than taking the backend down with it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "anyone there" },
    });
    expect(res.statusCode).toBe(502);
  });

  // The failed start is not cached, so the next caller gets a real attempt
  // rather than a stale rejection — and still an answer rather than a crash.
  it("says the same thing the second time it is asked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "still nobody" },
    });
    expect(res.statusCode).toBe(502);
  });

  it("reports no voices rather than throwing at the roster", async () => {
    const res = await app.inject({ url: "/api/assistant/voices" });
    expect(res.statusCode).toBe(200);
  });
});
