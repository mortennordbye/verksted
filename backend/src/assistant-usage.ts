import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantThreadUsage, SessionUsage } from "../../shared/api.js";
import { env } from "./env.js";
import { keyedQueue } from "./serial.js";

/**
 * What a conversation with the assistant has taken, one line per run of the CLI.
 *
 * Beside the thread rather than in it. A turn's entries are appended as the
 * model finishes each one and the count only arrives when the run ends, so
 * putting it "on the last entry" would mean rewriting a line of a file whose
 * whole safety is that it is only ever added to. A second append-only file
 * costs nothing and keeps that true.
 *
 * Not a `.jsonl`, so the thread list and `search` never read it as a
 * conversation: the same reason the participants file is not one.
 */
interface Line {
  at: string;
  /** Who ran; absent means the chair, as on an entry. */
  member?: string;
  usage: SessionUsage;
  /** Prompt tokens of the run's last model call. */
  context: number;
}

function usagePath(threadId: string): string {
  return path.join(env.ASSISTANT_DIR, `${threadId}.usage.log`);
}

const EMPTY: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

function add(total: AssistantThreadUsage, line: Line): AssistantThreadUsage {
  const a = total.total;
  const b = line.usage;
  const cost = (a.costUsd ?? 0) + (b.costUsd ?? 0);
  return {
    total: {
      input: a.input + b.input,
      output: a.output + b.output,
      cacheRead: a.cacheRead + b.cacheRead,
      cacheWrite: a.cacheWrite + b.cacheWrite,
      turns: a.turns + b.turns,
      ...(cost ? { costUsd: cost } : {}),
    },
    // The chair's conversation is the one every new turn sends again. An
    // advisor's is its own, and is two or three sentences a meeting.
    context: line.member || !line.context ? total.context : line.context,
  };
}

/**
 * Totals by thread, so a frame sent ten times a second while a reply streams
 * does not re-read the file for a number that changes once a turn. This
 * process is the file's only writer, so the cache is kept right by `record`.
 */
const totals = new Map<string, AssistantThreadUsage>();
const CACHED = 4;

function keep(threadId: string, total: AssistantThreadUsage): void {
  totals.delete(threadId);
  totals.set(threadId, total);
  for (const old of totals.keys()) {
    if (totals.size <= CACHED) break;
    totals.delete(old);
  }
}

/**
 * One chain per thread. A meeting's advisors finish together, and a load that
 * straddles another's append would count that line twice.
 */
const inTurn = keyedQueue();

const measured = (t: AssistantThreadUsage) =>
  t.total.input + t.total.output + t.total.cacheRead + t.total.cacheWrite > 0;

/** What the thread has taken so far; null before its first measured turn. */
export async function threadUsage(threadId: string): Promise<AssistantThreadUsage | null> {
  const total = totals.get(threadId) ?? (await inTurn(threadId, () => load(threadId)));
  return measured(total) ? total : null;
}

async function load(threadId: string): Promise<AssistantThreadUsage> {
  const cached = totals.get(threadId);
  if (cached) return cached;
  let raw = "";
  try {
    raw = await fs.readFile(usagePath(threadId), "utf8");
  } catch {
    // No file: a thread from before this was kept, or one that has not answered.
  }
  let total: AssistantThreadUsage = { total: EMPTY, context: 0 };
  for (const text of raw.split("\n")) {
    if (!text) continue;
    try {
      total = add(total, JSON.parse(text) as Line);
    } catch {
      // A torn append costs the one line, as in the thread itself.
    }
  }
  keep(threadId, total);
  return total;
}

export async function recordUsage(
  threadId: string,
  taken: { member?: string; usage: SessionUsage; context: number },
): Promise<void> {
  const line: Line = { at: new Date().toISOString(), ...taken };
  await inTurn(threadId, async () => {
    const before = await load(threadId);
    await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
    await fs.appendFile(usagePath(threadId), `${JSON.stringify(line)}\n`);
    keep(threadId, add(before, line));
  });
}

export async function forgetUsage(threadId: string): Promise<void> {
  totals.delete(threadId);
  await fs.rm(usagePath(threadId), { force: true });
}

/** For tests, which clear the directory between cases. */
export function resetUsageCache(): void {
  totals.clear();
}
