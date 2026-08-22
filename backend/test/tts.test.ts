import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AssistantVoices, CouncilMember } from "../../shared/api.js";

/**
 * The voice, without the model.
 *
 * A fake worker speaking the same one-JSON-line-in, one-JSON-line-out protocol
 * as runtime/vk-say.py. What that leaves untested is Kokoro itself; what it
 * covers is everything around it — the warm process, the queue, which failures
 * are the caller's fault and which are the pod's, and the answer a pod with no
 * model gives, which is the one every browser depends on to fall back.
 */
const WORKER = `
const readline = require("node:readline");
const fs = require("node:fs");
process.stdout.write(JSON.stringify({ ready: true, voices: ["af_heart", "bf_emma"], rate: 24000 }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const req = JSON.parse(line);
  if (req.text.includes("boom")) {
    process.stdout.write(JSON.stringify({ ok: false, error: "RuntimeError: boom" }) + "\\n");
    return;
  }
  // A WAV header and one sample: the route only has to carry the bytes.
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + 2, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24);
  header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(2, 40);
  fs.writeFileSync(req.out, Buffer.concat([header, Buffer.from([1, 0])]));
  fs.appendFileSync(process.env.VK_FAKE_LOG, JSON.stringify({ text: req.text, voice: req.voice }) + "\\n");
  process.stdout.write(JSON.stringify({ ok: true, seconds: 0.1 }) + "\\n");
});
`;

let app: FastifyInstance;
let dir: string;
let log: string;
let councilDir: string;

function saidSoFar(): { text: string; voice: string }[] {
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-"));
  log = path.join(dir, "said.jsonl");
  fs.writeFileSync(log, "");
  fs.writeFileSync(path.join(dir, "worker.cjs"), WORKER);
  // available() only asks whether the four files exist; the model and the voice
  // pack are never opened by anything but the worker.
  fs.writeFileSync(path.join(dir, "model.onnx"), "not really a model");
  fs.writeFileSync(path.join(dir, "voices.bin"), "not really voices");

  process.env.VK_FAKE_LOG = log;
  process.env.KOKORO_PYTHON = process.execPath;
  process.env.KOKORO_SCRIPT = path.join(dir, "worker.cjs");
  process.env.KOKORO_MODEL = path.join(dir, "model.onnx");
  process.env.KOKORO_VOICES = path.join(dir, "voices.bin");
  process.env.KOKORO_VOICE = "af_heart";
  councilDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-council-"));
  process.env.COUNCIL_DIR = councilDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-tts-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  const { stop } = await import("../src/tts.js");
  stop();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(councilDir, { recursive: true, force: true });
});

describe("GET /api/assistant/voices", () => {
  it("reports what the model has, and which one is the default", async () => {
    const res = await app.inject({ url: "/api/assistant/voices" });
    expect(res.statusCode).toBe(200);
    expect(res.json<AssistantVoices>()).toEqual({
      voices: ["af_heart", "bf_emma"],
      current: "af_heart",
    });
  });
});

describe("POST /api/assistant/speak", () => {
  it("answers with audio", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "Three commits on main." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("audio/wav");
    expect(res.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
  });

  it("speaks in the pod's default voice when the caller names none", () => {
    expect(saidSoFar().at(-1)).toEqual({ text: "Three commits on main.", voice: "af_heart" });
  });

  it("speaks in the voice the caller asked for", async () => {
    await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "In another voice.", voice: "bf_emma" },
    });
    expect(saidSoFar().at(-1)).toEqual({ text: "In another voice.", voice: "bf_emma" });
  });

  // The caller's mistake, not the pod's: a 502 here reads as "the voice broke"
  // and sends a client looking in the wrong place.
  it("400s a voice the model does not have", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "hello", voice: "nope" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s an empty or oversized request", async () => {
    const empty = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "" },
    });
    expect(empty.statusCode).toBe(400);
    const huge = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "x".repeat(5000) },
    });
    expect(huge.statusCode).toBe(400);
  });

  it("502s when the worker cannot say it", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "boom goes the model" },
    });
    expect(res.statusCode).toBe(502);
  });

  // One worker, one sentence at a time. Two requests at once must both be
  // answered rather than interleaved into each other's audio.
  it("serialises concurrent requests instead of crossing them", async () => {
    const [a, b] = await Promise.all([
      app.inject({ method: "POST", url: "/api/assistant/speak", payload: { text: "first one" } }),
      app.inject({ method: "POST", url: "/api/assistant/speak", payload: { text: "second one" } }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const texts = saidSoFar().map((s) => s.text);
    expect(texts).toContain("first one");
    expect(texts).toContain("second one");
  });

  // The signal the browser falls back on. Without it a pod that has no model
  // looks like a pod whose voice is broken, and nothing reads anything aloud.
  it("503s when this pod has no voice at all", async () => {
    fs.rmSync(path.join(dir, "model.onnx"));
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/speak",
      payload: { text: "anyone there" },
    });
    expect(res.statusCode).toBe(503);
    const voices = await app.inject({ url: "/api/assistant/voices" });
    expect(voices.json<AssistantVoices>().voices).toEqual([]);
    fs.writeFileSync(path.join(dir, "model.onnx"), "not really a model");
  });
});

/**
 * The one question the roster asks the voice.
 *
 * A member's voice is a name in a JSON file, and on a pod with no model there
 * is no list to check it against — so the check is here rather than in the
 * store, and only when there is something to check. Where there is, a typo is
 * an error on the form instead of a sample button that does nothing.
 */
describe("PUT /api/council/:id", () => {
  const michael = { name: "Michael", remit: "the cluster", tools: ["status"] };

  function saved(): CouncilMember {
    return JSON.parse(fs.readFileSync(path.join(councilDir, "michael.json"), "utf8"));
  }

  it("saves a voice the model has", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/council/michael",
      payload: { ...michael, voice: "bf_emma" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<CouncilMember>().voice).toBe("bf_emma");
  });

  it("400s a voice the model does not have, and leaves the member alone", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/council/michael",
      payload: { ...michael, voice: "bf_emmma" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toMatch(/no such voice/);
    expect(saved().voice).toBe("bf_emma");
  });

  // The trade this check is worth making only one way round: a pod without the
  // voice model still has a council, and holding the roster hostage to an
  // optional feature would be the worse failure.
  it("takes any name on a pod with no voice at all", async () => {
    fs.rmSync(path.join(dir, "model.onnx"));
    try {
      const res = await app.inject({
        method: "PUT",
        url: "/api/council/michael",
        payload: { ...michael, voice: "whoever" },
      });
      expect(res.statusCode).toBe(200);
      expect(saved().voice).toBe("whoever");
    } finally {
      fs.writeFileSync(path.join(dir, "model.onnx"), "not really a model");
    }
  });
});
