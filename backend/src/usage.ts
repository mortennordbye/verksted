import fs from "node:fs/promises";
import path from "node:path";
import type {
  PlanUsage,
  Session,
  SessionUsage,
  UsageDay,
  UsageMonth,
  UsageSummary,
} from "../../shared/api.js";
import { subagentDir, transcriptPath } from "./claude-home.js";
import { env } from "./env.js";

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

const EMPTY: SessionUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 0,
  costUsd: 0,
};

/**
 * API list prices, dollars per million tokens, input and output. Cache writes
 * are 1.25× input and cache reads 0.1× input, as on every current model. Kept
 * here rather than fetched: the figure is for fun — nothing is billed — and a
 * stale price is a stale joke, not a wrong bill. Matched by family when a
 * model id is not listed, so a new release counts as its siblings until this
 * table catches up. Prices as of 2026-06.
 */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /fable|mythos/, input: 10, output: 50 },
  { match: /opus/, input: 5, output: 25 },
  { match: /sonnet-5/, input: 2, output: 10 },
  { match: /sonnet/, input: 3, output: 15 },
  { match: /haiku/, input: 1, output: 5 },
];

/** Notional dollars for one message's usage on one model. */
export function priceOf(
  model: string | undefined,
  u: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const price = PRICES.find((p) => p.match.test(model ?? "")) ?? PRICES[1];
  return (
    (u.input * price.input +
      u.cacheWrite * price.input * 1.25 +
      u.cacheRead * price.input * 0.1 +
      u.output * price.output) /
    1e6
  );
}

interface Entry {
  type?: string;
  uuid?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
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
    const one = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
    };
    into.input += one.input;
    into.output += one.output;
    into.cacheRead += one.cacheRead;
    into.cacheWrite += one.cacheWrite;
    into.turns += 1;
    into.costUsd = (into.costUsd ?? 0) + priceOf(entry.message?.model, one);
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

/** Trailing windows; 0 days is everything the volume remembers. */
const WINDOWS: { label: string; days: number }[] = [
  { label: "24 hours", days: 1 },
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "all time", days: 0 },
];

/** How many projects the thirty-day list names; the rest fold into "other". */
const MAX_PROJECTS = 6;

/** Days on the bar row. */
const DAYS = 30;

/** A timestamp's calendar day where the pod is, as YYYY-MM-DD. */
const dayOf = (() => {
  const fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: env.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (ms: number) => fmt.format(new Date(ms));
})();

/** The same, to the month: YYYY-MM. */
const monthOf = (ms: number) => dayOf(ms).slice(0, 7);

/** Every month from `from` to `to`, inclusive, as YYYY-MM. */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split("-").map(Number);
  while (true) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(key);
    if (key >= to || out.length > 240) break;
    if (++m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}

/**
 * The dashboard's numbers from the session list. Only finished sessions have
 * a measurement, and a session counts in the window its end fell in.
 */
export function summarize(
  sessions: Session[],
  now = Date.now(),
  plan: PlanUsage | null = null,
): UsageSummary {
  const measured = sessions.filter(
    (s): s is Session & { usage: SessionUsage; endedAt: string } => !!s.usage && !!s.endedAt,
  );
  const windows = WINDOWS.map(({ label, days }) => {
    const since = days ? now - days * 24 * 60 * 60_000 : -Infinity;
    const inWindow = measured.filter((s) => Date.parse(s.endedAt) >= since);
    const tokens = { ...EMPTY };
    let unattended = 0;
    let costUsd = 0;
    for (const s of inWindow) {
      tokens.input += s.usage.input;
      tokens.output += s.usage.output;
      tokens.cacheRead += s.usage.cacheRead;
      tokens.cacheWrite += s.usage.cacheWrite;
      tokens.turns += s.usage.turns;
      costUsd += s.usage.costUsd ?? 0;
      if (s.unattended) unattended += totalTokens(s.usage);
    }
    delete tokens.costUsd;
    return { label, days, tokens, sessions: inWindow.length, unattended, costUsd };
  });

  const since = now - 30 * 24 * 60 * 60_000;
  const month = measured.filter((s) => Date.parse(s.endedAt) >= since);
  const byProject = new Map<string, { total: number; sessions: number; costUsd: number }>();
  for (const s of month) {
    const row = byProject.get(s.project) ?? { total: 0, sessions: 0, costUsd: 0 };
    row.total += totalTokens(s.usage);
    row.sessions += 1;
    row.costUsd += s.usage.costUsd ?? 0;
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
      costUsd: rest.reduce((n, r) => n + r.costUsd, 0),
    });
  }

  // How the month's sessions went, from their own sign-offs. A session that
  // wrote none is "done", which is where an interactive one usually lands.
  const outcomes = { ok: 0, attention: 0, failed: 0, done: 0 };
  for (const s of sessions) {
    if (!s.endedAt || Date.parse(s.endedAt) < since) continue;
    if (s.outcome in outcomes) outcomes[s.outcome as keyof typeof outcomes] += 1;
  }

  // Every day present, zero or not: a gap in a bar row reads as missing data,
  // and a quiet day is data.
  const byDay = new Map<string, UsageDay>();
  for (let i = DAYS - 1; i >= 0; i--) {
    const date = dayOf(now - i * 24 * 60 * 60_000);
    byDay.set(date, { date, total: 0, unattended: 0, costUsd: 0 });
  }
  for (const s of measured) {
    const day = byDay.get(dayOf(Date.parse(s.endedAt)));
    if (!day) continue;
    day.total += totalTokens(s.usage);
    day.costUsd += s.usage.costUsd ?? 0;
    if (s.unattended) day.unattended += totalTokens(s.usage);
  }

  // Every month from the first measured session to this one, all time.
  const byMonth = new Map<string, UsageMonth>();
  const firstEnd = measured.reduce(
    (min, s) => Math.min(min, Date.parse(s.endedAt)),
    Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(firstEnd)) {
    for (const month of monthsBetween(monthOf(firstEnd), monthOf(now))) {
      byMonth.set(month, { month, total: 0, unattended: 0, costUsd: 0 });
    }
    for (const s of measured) {
      const row = byMonth.get(monthOf(Date.parse(s.endedAt)));
      if (!row) continue;
      row.total += totalTokens(s.usage);
      row.costUsd += s.usage.costUsd ?? 0;
      if (s.unattended) row.unattended += totalTokens(s.usage);
    }
  }

  return {
    windows,
    projects,
    days: [...byDay.values()],
    months: [...byMonth.values()],
    outcomes,
    plan,
  };
}
