import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type { Schedule } from "../../shared/api.js";
import { env } from "./env.js";
import { readReport } from "./sessions-store.js";

/** Generated ids only — nothing from a client is ever used as a filename. */
export const SCHEDULE_ID_RE = /^sch-[0-9a-f]{8}$/;

/** The stored record; the rest of the wire type is derived on every read. */
type Stored = Omit<Schedule, "nextRunAt" | "lastReport">;

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
    return new Cron(cron).nextRun()?.toISOString() ?? null;
  } catch {
    return null;
  }
}

/** True when croner can build a job from the pattern — the only cron check. */
export function validCron(cron: string): boolean {
  try {
    return new Cron(cron).nextRun() !== null;
  } catch {
    return false;
  }
}

async function toWire(s: Stored): Promise<Schedule> {
  return {
    ...s,
    jitterMinutes: s.jitterMinutes ?? 0,
    // nextRunAt is the cron time; the jitter is drawn when it fires.
    nextRunAt: nextRun(s.cron, s.enabled),
    lastReport: s.lastSessionId ? await readReport(s.lastSessionId) : null,
  };
}

async function write(s: Stored): Promise<void> {
  await fs.writeFile(filePath(s.id), JSON.stringify(s, null, 2));
}

async function readStored(id: string): Promise<Stored | null> {
  if (!SCHEDULE_ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(filePath(id), "utf8"));
  } catch {
    return null;
  }
}

export async function listSchedules(): Promise<Schedule[]> {
  const files = await fs.readdir(env.SCHEDULES_DIR).catch(() => []);
  const out: Schedule[] = [];
  for (const f of files.filter((f) => f.endsWith(".json") && SCHEDULE_ID_RE.test(f.slice(0, -5)))) {
    try {
      out.push(
        await toWire(JSON.parse(await fs.readFile(path.join(env.SCHEDULES_DIR, f), "utf8"))),
      );
    } catch {
      // Skip an unreadable file rather than failing the whole list.
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getSchedule(id: string): Promise<Schedule | null> {
  const stored = await readStored(id);
  return stored && (await toWire(stored));
}

export async function createSchedule(
  input: Pick<Schedule, "name" | "project" | "cron" | "prompt"> & {
    enabled?: boolean;
    jitterMinutes?: number;
  },
): Promise<Schedule> {
  const stored: Stored = {
    id: `sch-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    name: input.name,
    project: input.project,
    cron: input.cron,
    jitterMinutes: input.jitterMinutes ?? 0,
    prompt: input.prompt,
    enabled: input.enabled ?? true,
    createdAt: new Date().toISOString(),
    lastRunAt: null,
    lastSessionId: null,
    lastError: null,
  };
  await write(stored);
  return toWire(stored);
}

export async function updateSchedule(
  id: string,
  patch: Partial<Pick<Schedule, "name" | "cron" | "jitterMinutes" | "prompt" | "enabled">>,
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

/** Stamp the outcome of a run: the session it started, or why it started none. */
export async function recordRun(
  id: string,
  result: { sessionId?: string; error?: string },
): Promise<void> {
  const stored = await readStored(id);
  if (!stored) return;
  await write({
    ...stored,
    lastRunAt: new Date().toISOString(),
    lastSessionId: result.sessionId ?? null,
    lastError: result.error ?? null,
  });
}
