import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { env } from "./env.js";

/**
 * The assistant's voice, on the pod.
 *
 * The browser's speechSynthesis was the one part of voice mode that sounded
 * like a machine, and on the device this app is mostly used from it is also the
 * worst: iOS Safari never exposes Siri or the downloaded enhanced voices to a
 * web page, so the voice picker could only ever choose between the bad ones.
 * Kokoro is a small neural model that sounds like a person, and running it here
 * keeps the reply on the network — the same reason whisper transcribes here.
 *
 * One warm worker (runtime/vk-say.py), because loading the model costs about a
 * second and a reply is spoken a sentence at a time. Requests are serialised:
 * synthesis is CPU-bound and two at once would only make both slower.
 */

/** How long a silent worker is kept before its memory is given back. */
const IDLE_MS = 10 * 60_000;
/** A wedged worker must not hold the queue for ever. */
const REQUEST_TIMEOUT_MS = 60_000;
/** One sentence at a time — the frontend splits; this is the ceiling per chunk. */
export const MAX_TEXT = 800;

interface Ready {
  ready: true;
  voices: string[];
  rate: number;
}

interface Answer {
  ok: boolean;
  error?: string;
}

interface Worker {
  proc: ChildProcessWithoutNullStreams;
  voices: string[];
  /** Resolves the request currently in flight. */
  pending: ((answer: Answer) => void) | null;
}

let worker: Worker | null = null;
let starting: Promise<Worker> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
/** Serialises requests; each one waits for the previous to answer. */
let queue: Promise<unknown> = Promise.resolve();

/** True when this pod has the model and the worker to run it. */
export function available(): boolean {
  return (
    existsSync(env.KOKORO_PYTHON) &&
    existsSync(env.KOKORO_SCRIPT) &&
    existsSync(env.KOKORO_MODEL) &&
    existsSync(env.KOKORO_VOICES)
  );
}

function idle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(stop, IDLE_MS);
  // The pod has other work; a voice nobody is using must not hold the process
  // open past its usefulness, and it costs a second to bring back.
  idleTimer.unref();
}

/** Stop the worker. Safe to call when there is none; the next request respawns. */
export function stop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  const current = worker;
  worker = null;
  starting = null;
  current?.pending?.({ ok: false, error: "the voice was shut down mid-sentence" });
  current?.proc.kill();
}

async function start(): Promise<Worker> {
  const proc = spawn(env.KOKORO_PYTHON, [env.KOKORO_SCRIPT], {
    env: {
      ...process.env,
      KOKORO_MODEL: env.KOKORO_MODEL,
      KOKORO_VOICES: env.KOKORO_VOICES,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    // Kept only as the reason a failed start can give; the model chatters here.
    stderr = (stderr + chunk.toString()).slice(-2000);
  });

  const entry: Worker = { proc, voices: [], pending: null };
  const lines = readline.createInterface({ input: proc.stdout });

  const ready = new Promise<Worker>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the voice did not start")), 60_000);
    lines.once("line", (line: string) => {
      clearTimeout(timer);
      try {
        const first = JSON.parse(line) as Ready;
        entry.voices = first.voices ?? [];
        resolve(entry);
      } catch {
        reject(new Error("the voice answered with something unreadable"));
      }
    });
    proc.once("exit", () => {
      clearTimeout(timer);
      reject(new Error(stderr.split("\n").filter(Boolean).at(-1) ?? "the voice stopped"));
    });
  });

  // Every line after the ready line answers whatever is in flight.
  lines.on("line", (line: string) => {
    const settle = entry.pending;
    if (!settle) return;
    entry.pending = null;
    try {
      settle(JSON.parse(line) as Answer);
    } catch {
      settle({ ok: false, error: "the voice answered with something unreadable" });
    }
  });
  proc.on("exit", () => {
    entry.pending?.({ ok: false, error: "the voice stopped" });
    entry.pending = null;
    if (worker === entry) worker = null;
  });

  return ready;
}

async function ensure(): Promise<Worker> {
  if (worker) return worker;
  // A second caller while the first is still loading waits for the same start,
  // or two models load at once and the slower one is orphaned.
  starting ??= start()
    .then((w) => {
      worker = w;
      starting = null;
      return w;
    })
    .catch((err: unknown) => {
      starting = null;
      throw err;
    });
  return starting;
}

/** The voices this model has. Empty when there is no voice on this pod. */
export async function voices(): Promise<string[]> {
  if (!available()) return [];
  const w = await ensure();
  idle();
  return w.voices;
}

/**
 * Speak one chunk. Returns WAV bytes.
 *
 * The worker writes to a file rather than down the pipe: WAV bytes and JSON
 * answers on one stream is a framing problem with no upside here.
 */
export async function synthesize(text: string, voice?: string): Promise<Buffer> {
  const body = text.trim().slice(0, MAX_TEXT);
  if (!body) throw new Error("nothing to say");

  const run = queue.then(async () => {
    const w = await ensure();
    if (voice && !w.voices.includes(voice)) throw new Error(`no such voice: ${voice}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vk-say-"));
    const out = path.join(dir, `${randomUUID()}.wav`);
    try {
      const answer = await new Promise<Answer>((resolve, reject) => {
        const timer = setTimeout(() => {
          // A worker that has stopped answering is not one to hand the next
          // sentence to; the request after this gets a fresh one.
          stop();
          reject(new Error("the voice took too long"));
        }, REQUEST_TIMEOUT_MS);
        w.pending = (a) => {
          clearTimeout(timer);
          resolve(a);
        };
        w.proc.stdin.write(
          JSON.stringify({ text: body, voice: voice ?? env.KOKORO_VOICE, out }) + "\n",
        );
      });
      if (!answer.ok) throw new Error(answer.error ?? "the voice failed");
      idle();
      return await fs.readFile(out);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  // The queue must not stay rejected: one failed sentence cannot poison the
  // ones after it.
  queue = run.catch(() => undefined);
  return run;
}
