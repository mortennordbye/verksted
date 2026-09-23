import fs from "node:fs/promises";
import path from "node:path";
import { readChat } from "./chat.js";
import * as feed from "./feed-store.js";
import type { Logger } from "./logger.js";
import { promptsIn } from "./transcripts.js";

/**
 * The newest real transcript, read the way the chat view and the harvest read
 * it, once a day.
 *
 * Every parser test is hand-written against today's transcript shape, and a
 * CLI release that moves one of the entries these read shows up as a chat
 * view that says nothing and a harvest that finds nothing, never as an error.
 * This is the one place a real file is read on purpose to ask whether they
 * still work, and a "no" is an inbox item rather than a silence.
 */
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Smaller than this is a session that never got going: nothing to judge by. */
const MIN_BYTES = 20_000;

async function newestTranscript(
  home: string,
  now: number,
): Promise<{ file: string; id: string } | null> {
  const root = path.join(home, ".claude", "projects");
  let best: { file: string; id: string; at: number } | null = null;
  for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
    for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(root, dir, name);
      const st = await fs.stat(file).catch(() => null);
      if (!st || st.size < MIN_BYTES || now - st.mtimeMs > WEEK_MS) continue;
      if (!best || st.mtimeMs > best.at) best = { file, id: name.slice(0, -6), at: st.mtimeMs };
    }
  }
  return best && { file: best.file, id: best.id };
}

/** What each reader made of it, or null when there was nothing recent to read. */
export async function checkTranscripts(
  home = process.env.HOME ?? "/data/home",
  now = Date.now(),
): Promise<{ file: string; turns: number; typed: number; problem: string | null } | null> {
  const newest = await newestTranscript(home, now);
  if (!newest) return null;
  const chat = await readChat(newest.file, newest.id, { bytes: 2_000_000 });
  const turns = chat.messages.filter((m) => m.role === "user" || m.role === "assistant").length;
  const typed = (await promptsIn(newest.file)).length;
  const saidByPerson = chat.messages.some((m) => m.role === "user");
  const problem =
    turns === 0
      ? "the chat view read no turns from it"
      : saidByPerson && typed === 0
        ? "the chat view found typed turns and the harvest found none"
        : null;
  return { file: newest.file, turns, typed, problem };
}

/** The daily run: a problem is filed once a day, and a clean read files nothing. */
export async function reportTranscripts(log: Pick<Logger, "warn">): Promise<void> {
  const result = await checkTranscripts();
  if (!result?.problem) return;
  const at = new Date().toISOString();
  log.warn({ file: result.file }, `transcript check: ${result.problem}`);
  await feed.upsert({
    id: "bench:transcript-shape",
    source: "bench",
    at,
    title: "a claude transcript no longer reads as it should",
    from: "the pod",
    facts: [
      path.basename(path.dirname(result.file)),
      `${result.turns} turns, ${result.typed} typed`,
    ],
    detail: `${result.problem}. The CLI may have changed its transcript shape: chat.ts and transcripts.ts read it.`,
    link: null,
    urgency: "attention",
    version: at.slice(0, 10),
  });
}
