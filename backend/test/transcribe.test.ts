import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { cleanTranscript } from "../src/transcribe.js";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * Whisper narrates what it hears, including when it hears nothing. Any of that
 * reaching the assistant as though it were a question means an answer to
 * silence, so this is the filter that decides whether a clip counts as speech.
 */
describe("cleanTranscript", () => {
  it("keeps what was actually said", () => {
    expect(cleanTranscript(" What needs me today?\n")).toBe("What needs me today?");
  });

  it("joins the lines a long clip is broken into", () => {
    expect(cleanTranscript("Start a session in Homelab\nand commit what is pending.")).toBe(
      "Start a session in Homelab and commit what is pending.",
    );
  });

  it("drops the timestamps whisper prefixes when it feels like it", () => {
    expect(cleanTranscript("[00:00:00.000 --> 00:00:02.000]  Merge the renovate PRs.")).toBe(
      "Merge the renovate PRs.",
    );
  });

  it("treats an empty clip as nothing said, not as a question", () => {
    expect(cleanTranscript("[BLANK_AUDIO]")).toBe("");
    expect(cleanTranscript("(silence)")).toBe("");
    // Whisper picks its own word for a noise, so the rule has to be structural
    // rather than a list: a real tone came back as "(beep)".
    expect(cleanTranscript("(beep)")).toBe("");
    expect(cleanTranscript("[ Silence ]")).toBe("");
    expect(cleanTranscript("  \n  ")).toBe("");
    // Whisper hears punctuation in room tone; a lone "." is not a question.
    expect(cleanTranscript(". . .")).toBe("");
  });

  it("keeps speech that happens to sit next to a noise marker", () => {
    expect(cleanTranscript("[MUSIC] what is running right now?")).toBe(
      "what is running right now?",
    );
  });
});

/**
 * The route, against a fake ffmpeg and a fake whisper.
 *
 * What is left untested is what the two of them make of real audio. What this
 * covers is what the pod does around them: how the clip is handed over, and
 * what happens to the fourth person who asks while three are waiting.
 */
describe("POST /api/assistant/transcribe", () => {
  let fake: FakeBin;
  let app: FastifyInstance;

  const clip = () =>
    app.inject({
      method: "POST",
      url: "/api/assistant/transcribe",
      headers: { "content-type": "audio/webm" },
      payload: Buffer.from("not really audio"),
    });

  beforeAll(async () => {
    fake = FakeBin.install(["ffmpeg", "whisper-cli"]);
    process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-stt-repos-"));
    process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-stt-sess-"));
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
    fake.reply("ffmpeg", "", {});
    fake.reply("whisper-cli", "", { stdout: "is the build green\n" });
  });

  it("answers with what was said", async () => {
    const res = await clip();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ text: "is the build green" });
  });

  it("422s a clip with nothing in it, and 415s a body that is not audio", async () => {
    fake.reply("whisper-cli", "", { stdout: "[BLANK_AUDIO]\n" });
    expect((await clip()).statusCode).toBe(422);
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/transcribe",
      payload: { text: "hello" },
    });
    expect(res.statusCode).toBe(415);
  });

  it("502s when ffmpeg cannot read it", async () => {
    fake.reply("ffmpeg", "", { code: 1, stderr: "Invalid data found" });
    expect((await clip()).statusCode).toBe(502);
  });

  it("lets ffmpeg open the clip and nothing the clip names, and only so much of it", async () => {
    // A playlist is a "recording" too, and what it lists is opened by whoever
    // reads it. Before the input, or it does not apply to it.
    await clip();
    const [argv] = fake.argvFor("ffmpeg");
    expect(argv.indexOf("-protocol_whitelist")).toBeGreaterThan(-1);
    expect(argv[argv.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
    expect(argv.indexOf("-protocol_whitelist")).toBeLessThan(argv.indexOf("-i"));
    expect(argv.indexOf("-t")).toBeGreaterThan(argv.indexOf("-i"));
  });

  it("transcribes one at a time, and refuses the clip that would make a fourth waiting", async () => {
    fake.reply("whisper-cli", "", { stdout: "slow\n", delayMs: 300 });
    const codes = (await Promise.all([clip(), clip(), clip(), clip(), clip()])).map(
      (r) => r.statusCode,
    );
    expect(codes.filter((c) => c === 200)).toHaveLength(3);
    expect(codes.filter((c) => c === 429)).toHaveLength(2);
    // Refused means never started.
    expect(fake.argvFor("whisper-cli")).toHaveLength(3);
    // And the queue is free again afterwards.
    expect((await clip()).statusCode).toBe(200);
  });
});
