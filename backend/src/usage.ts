import fs from "node:fs/promises";
import path from "node:path";
import type { Session, SessionUsage, UsageSummary } from "../../shared/api.js";
import { subagentDir, transcriptPath } from "./claude-home.js";

/**
 * What a session cost, in tokens, read out of the transcript it wrote.
 *
 * Nothing here is billed: every session runs on the subscription, and what the
 * subscription meters is its own rate limits. Tokens are still the number to
 * watch — a maintainer that runs three stages a night on three repos is a
 * share of the same allowance the day's interactive work draws on, and the
 * only way to know how big a share is to add it up.
 *
 * Claude records `usage` on every assistant entry of the transcript. One API
 * response is written as several entries — one per content block, the same
 * usage on each — so they are summed once per message, not once per line.
 */

const EMPTY: SessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };

interface Entry {
  type?: string;
  uuid?: string;
  requestId?: string;
  message?: {
    id?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

/** Sum one transcript file into `into`, once per API message. */
async function addFile(file: string, into: SessionUsage, seen: Set<string>): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = entry.type === "assistant" ? entry.message?.usage : undefined;
    if (!usage) continue;
    const key = entry.message?.id ?? entry.requestId ?? entry.uuid ?? line;
    if (seen.has(key)) continue;
    seen.add(key);
    into.input += usage.input_tokens ?? 0;
    into.output += usage.output_tokens ?? 0;
    into.cacheRead += usage.cache_read_input_tokens ?? 0;
    into.cacheWrite += usage.cache_creation_input_tokens ?? 0;
    into.turns += 1;
  }
  return true;
}

/**
 * The tokens one conversation spent, subagents included; null when there is
 * no transcript to read (a session whose agent never started, or one whose
 * conversation claude never recorded).
 */
export async function usageOf(
  repoDir: string,
  conversationId: string,
): Promise<SessionUsage | null> {
  const total = { ...EMPTY };
  const seen = new Set<string>();
  if (!(await addFile(transcriptPath(repoDir, conversationId), total, seen))) return null;
  const dir = subagentDir(repoDir, conversationId);
  for (const f of await fs.readdir(dir).catch(() => [] as string[])) {
    if (f.endsWith(".jsonl")) await addFile(path.join(dir, f), total, seen);
  }
  return total;
}

/** Every token a session was charged for, whichever bucket it landed in. */
export function totalTokens(u: SessionUsage): number {
  return u.input + u.output + u.cacheRead + u.cacheWrite;
}

const WINDOWS: { label: string; days: number }[] = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
];

/** How many projects the thirty-day list names; the rest fold into "other". */
const MAX_PROJECTS = 6;

/**
 * The dashboard's numbers from the session list. Only finished sessions have
 * a measurement, and a session counts in the window its end fell in.
 */
export function summarize(sessions: Session[], now = Date.now()): UsageSummary {
  const measured = sessions.filter(
    (s): s is Session & { usage: SessionUsage; endedAt: string } => !!s.usage && !!s.endedAt,
  );
  const windows = WINDOWS.map(({ label, days }) => {
    const since = now - days * 24 * 60 * 60_000;
    const inWindow = measured.filter((s) => Date.parse(s.endedAt) >= since);
    const tokens = { ...EMPTY };
    let unattended = 0;
    for (const s of inWindow) {
      tokens.input += s.usage.input;
      tokens.output += s.usage.output;
      tokens.cacheRead += s.usage.cacheRead;
      tokens.cacheWrite += s.usage.cacheWrite;
      tokens.turns += s.usage.turns;
      if (s.unattended) unattended += totalTokens(s.usage);
    }
    return { label, days, tokens, sessions: inWindow.length, unattended };
  });

  const since = now - 30 * 24 * 60 * 60_000;
  const byProject = new Map<string, { total: number; sessions: number }>();
  for (const s of measured) {
    if (Date.parse(s.endedAt) < since) continue;
    const row = byProject.get(s.project) ?? { total: 0, sessions: 0 };
    row.total += totalTokens(s.usage);
    row.sessions += 1;
    byProject.set(s.project, row);
  }
  const ranked = [...byProject]
    .map(([project, row]) => ({ project, ...row }))
    .sort((a, b) => b.total - a.total);
  const projects = ranked.slice(0, MAX_PROJECTS);
  const rest = ranked.slice(MAX_PROJECTS);
  if (rest.length) {
    projects.push({
      project: `${rest.length} other`,
      total: rest.reduce((n, r) => n + r.total, 0),
      sessions: rest.reduce((n, r) => n + r.sessions, 0),
    });
  }
  return { windows, projects };
}
