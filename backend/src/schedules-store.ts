import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type { Schedule, ScheduleRun, Session } from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";
import { listSessions, readReport } from "./sessions-store.js";

/** Generated ids only — nothing from a client is ever used as a filename. */
export const SCHEDULE_ID_RE = /^sch-[0-9a-f]{8}$/;

/** Firings kept per schedule. Enough to see a pattern, small enough to reread. */
const MAX_RUNS = 20;

interface StoredRun {
  at: string;
  sessionId: string | null;
  error: string | null;
  /**
   * What an assistant run replied. A session run has none: its verdict lives in
   * the report file the session wrote, and is read back by id.
   */
  reply?: string | null;
}

/** The stored record; the rest of the wire type is derived on every read. */
type Stored = Omit<
  Schedule,
  "nextRunAt" | "lastReport" | "lastRunAt" | "lastSessionId" | "lastError" | "lastFiredAt"
> & {
  /** Newest first, capped at MAX_RUNS. */
  runs: StoredRun[];
  /** Absent on every record written before catch-up existed. */
  lastFiredAt?: string;
};

function filePath(id: string): string {
  return path.join(env.SCHEDULES_DIR, `${id}.json`);
}

/**
 * The next fire time, or null when the schedule is off or the pattern no longer
 * parses (a record written by an older/hand-edited file).
 */
export function nextRun(cron: string, enabled: boolean): string | null {
  if (!enabled) return null;
  try {
    return new Cron(cron, { timezone: env.TZ }).nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/** True when croner can build a job from the pattern — the only cron check. */
export function validCron(cron: string): boolean {
  try {
    return new Cron(cron, { timezone: env.TZ }).nextRun() !== null;
  } catch {
    return false;
  }
}

/** Every schedule written before assistant runs existed starts a session. */
const kindOf = (s: Stored): Schedule["kind"] => (s.kind === "assistant" ? "assistant" : "session");

async function toWire(s: Stored): Promise<Schedule> {
  const last = s.runs?.[0];
  return {
    ...s,
    kind: kindOf(s),
    jitterMinutes: s.jitterMinutes ?? 0,
    skipWhenIdle: s.skipWhenIdle ?? false,
    // nextRunAt is the cron time; the jitter is drawn when it fires.
    nextRunAt: nextRun(s.cron, s.enabled),
    lastFiredAt: s.lastFiredAt ?? null,
    lastRunAt: last?.at ?? null,
    lastSessionId: last?.sessionId ?? null,
    lastError: last?.error ?? null,
    // An assistant run is its own report: there is no session to have written
    // one, and what it said is the whole outcome.
    lastReport: last?.reply ?? (last?.sessionId ? await readReport(last.sessionId) : null),
  };
}

/**
 * Atomic, because the scheduler stamps a schedule while the UI is polling it —
 * see writeJsonAtomic. A torn read here surfaced as a schedule that existed a
 * moment ago reading back as null, since readStored cannot tell a half-written
 * file from a missing one.
 */
async function write(s: Stored): Promise<void> {
  await writeJsonAtomic(filePath(s.id), s);
}

async function readStored(id: string): Promise<Stored | null> {
  if (!SCHEDULE_ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(filePath(id), "utf8"));
  } catch {
    return null;
  }
}

async function readAllStored(): Promise<Stored[]> {
  const files = await fs.readdir(env.SCHEDULES_DIR).catch(() => []);
  const out: Stored[] = [];
  for (const f of files.filter((f) => f.endsWith(".json") && SCHEDULE_ID_RE.test(f.slice(0, -5)))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(env.SCHEDULES_DIR, f), "utf8")));
    } catch {
      // Skip an unreadable file rather than failing the whole list.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Every schedule, or only the ones that run in `project` when given. */
export async function listSchedules(project?: string): Promise<Schedule[]> {
  const out: Schedule[] = [];
  for (const stored of await readAllStored()) {
    if (project !== undefined && stored.project !== project) continue;
    out.push(await toWire(stored));
  }
  return out;
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const stored = await readStored(id);
  return stored && (await toWire(stored));
}

export async function createSchedule(
  input: Pick<Schedule, "name" | "project" | "cron" | "prompt"> & {
    kind?: Schedule["kind"];
    enabled?: boolean;
    jitterMinutes?: number;
    skipWhenIdle?: boolean;
  },
): Promise<Schedule> {
  const kind = input.kind ?? "session";
  const stored: Stored = {
    id: `sch-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    name: input.name,
    kind,
    // An assistant schedule runs in no repo, and storing one it does not use
    // would put a stale name in the UI and in every run it records.
    project: kind === "assistant" ? "" : input.project,
    cron: input.cron,
    jitterMinutes: input.jitterMinutes ?? 0,
    skipWhenIdle: input.skipWhenIdle ?? false,
    prompt: input.prompt,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
    runs: [],
  };
  await write(stored);
  return toWire(stored);
}

export async function updateSchedule(
  id: string,
  patch: Partial<
    Pick<Schedule, "name" | "cron" | "jitterMinutes" | "prompt" | "enabled" | "skipWhenIdle">
  >,
): Promise<Schedule | null> {
  const stored = await readStored(id);
  if (!stored) return null;
  const next = { ...stored, ...patch };
  await write(next);
  return toWire(next);
}

export async function deleteSchedule(id: string): Promise<boolean> {
  if (!(await readStored(id))) return false;
  await fs.rm(filePath(id), { force: true });
  return true;
}

/**
 * Mark this tick accounted for. Written whenever a timer fires — before the
 * pause switch, the idle rule and every ceiling, because all of those are the
 * schedule deciding rather than the schedule missing — and when a boot writes
 * off a tick it was down for. What it buys is the next boot: the first cron
 * occurrence after this stamp that is already in the past is a tick nobody ran.
 */
export async function stampFired(id: string): Promise<void> {
  const stored = await readStored(id);
  if (!stored) return;
  await write({ ...stored, lastFiredAt: new Date().toISOString() });
}

/** Stamp the outcome of a run: the session it started, or why it started none. */
export async function recordRun(
  id: string,
  result: { sessionId?: string; reply?: string; error?: string },
): Promise<void> {
  const stored = await readStored(id);
  if (!stored) return;
  const run: StoredRun = {
    at: new Date().toISOString(),
    sessionId: result.sessionId ?? null,
    error: result.error ?? null,
    reply: result.reply ?? null,
  };
  await write({ ...stored, runs: [run, ...(stored.runs ?? [])].slice(0, MAX_RUNS) });
}

/**
 * A run rolled into one word. What it said about itself wins — that is the
 * whole point of asking it to sign off — and only a run that said nothing is
 * judged by where it got to instead.
 */
function outcome(
  run: StoredRun,
  report: string | null,
  session: Session | undefined,
): ScheduleRun["outcome"] {
  if (run.error) return "blocked";
  if (report) {
    if (/^attention\b/i.test(report)) return "attention";
    if (/^failed\b/i.test(report)) return "failed";
    if (/^ok\b/i.test(report)) return "ok";
  }
  return session && session.status !== "done" ? "running" : "done";
}

/**
 * Every firing across every schedule, newest first — what happened while you
 * were not looking. Sessions are listed once and matched up here rather than
 * fetched per run: each lookup would otherwise shell out to tmux.
 */
export async function listRuns(limit = 50): Promise<ScheduleRun[]> {
  const schedules = await readAllStored();
  const sessions = new Map((await listSessions()).map((s) => [s.id, s]));
  const rows = schedules
    .flatMap((s) => (s.runs ?? []).map((run) => ({ s, run })))
    .sort((a, b) => b.run.at.localeCompare(a.run.at))
    .slice(0, limit);
  const out: ScheduleRun[] = [];
  for (const { s, run } of rows) {
    const report = run.reply ?? (run.sessionId ? await readReport(run.sessionId) : null);
    const session = run.sessionId ? sessions.get(run.sessionId) : undefined;
    out.push({
      scheduleId: s.id,
      schedule: s.name,
      kind: kindOf(s),
      project: s.project,
      at: run.at,
      sessionId: run.sessionId,
      error: run.error,
      report,
      outcome: outcome(run, report, session),
      work: session?.work ?? null,
    });
  }
  return out;
}
