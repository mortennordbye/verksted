import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exec } from "./exec.js";

/**
 * Speech to text, on the pod.
 *
 * Claude takes text and images, never audio, so a spoken question has to become
 * text before it can be asked at all. Doing that here rather than in the browser
 * is what makes voice work on every device instead of the two browsers that
 * ship a recogniser — and it means the recording never leaves the network, which
 * is the same reason this app has no public ingress.
 *
 * whisper-cli and the model are baked into the image (see the Dockerfile);
 * ffmpeg is what turns whatever the browser recorded into the 16 kHz mono WAV
 * whisper wants. Both are external commands run through execFile with argument
 * arrays, never a shell.
 */

const MODEL = "/usr/local/share/whisper/ggml-base.en.bin";

/** A clip long enough to hold a spoken question, and no longer. */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;

/**
 * Whisper narrates its own non-speech, and it is inventive about it: an empty
 * clip comes back as "[BLANK_AUDIO]", a hum as "(beep)", a fan as "(music)".
 * Enumerating the words it might choose is a losing game — the reliable rule is
 * structural. Whisper brackets sounds and leaves speech bare, so a transcript
 * with nothing outside its brackets is a transcript of no speech.
 *
 * Sending any of it to the assistant as though it were a question means waiting
 * for an answer to silence.
 */
export function cleanTranscript(raw: string): string {
  const text = raw
    .split("\n")
    .map((line) => line.replace(/^\s*\[[\d:.\s\->]+\]\s*/, "").trim())
    .join(" ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // What is left is either words or punctuation whisper heard in room tone.
  return /[a-z0-9]/i.test(text) ? text : "";
}

/** Transcribe a recorded clip. Returns "" when nothing was said. */
export async function transcribe(audio: Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vk-voice-"));
  const input = path.join(dir, `clip-${randomUUID()}`);
  const wav = `${input}.wav`;
  try {
    await fs.writeFile(input, audio);
    // Whatever the browser produced — webm/opus on Chrome, mp4/aac on Safari —
    // becomes the one format whisper reads. -y because the target is ours.
    await exec("ffmpeg", ["-nostdin", "-y", "-i", input, "-ar", "16000", "-ac", "1", wav], {
      timeout: 60_000,
    });
    const { stdout } = await exec(
      "whisper-cli",
      ["-m", MODEL, "-f", wav, "--output-txt", "--no-timestamps", "--no-prints", "-t", "4"],
      { timeout: 120_000 },
    );
    // --output-txt writes beside the wav; stdout carries it too, and reading the
    // file is the reliable half when whisper decides to be chatty on stdout.
    const fromFile = await fs.readFile(`${wav}.txt`, "utf8").catch(() => "");
    return cleanTranscript(fromFile || stdout);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
