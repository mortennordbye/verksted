import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, Feedback } from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";

/** Generated ids only — nothing from a caller is ever used as a filename. */
export const FEEDBACK_ID_RE = /^fb-[0-9a-f]{8}$/;

/** A note, not a design document: the point is the one thing that was missing. */
export const MAX_TEXT = 1000;

/**
 * What an agent said the bench was missing, one JSON file per note.
 *
 * A file per record for the same reason sessions and schedules are: the volume
 * is the database, and a note has to survive a pod that dies between writing it
 * and reading it.
 */
function filePath(id: string): string {
  return path.join(env.FEEDBACK_DIR, `${id}.json`);
}

export async function list(): Promise<Feedback[]> {
  let files: string[];
  try {
    files = await fs.readdir(env.FEEDBACK_DIR);
  } catch {
    return []; // Nothing has been filed yet.
  }
  const out: Feedback[] = [];
  for (const f of files.filter((f) => f.endsWith(".json") && FEEDBACK_ID_RE.test(f.slice(0, -5)))) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(env.FEEDBACK_DIR, f), "utf8")));
    } catch {
      // Skip an unreadable note rather than failing the whole list.
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * File a note, unless the same one is already waiting.
 *
 * The duplicate check is the whole rate limit: every session is told about this
 * command, and an agent that hits the same limitation on Monday and Thursday
 * would otherwise report it twice. One entry per distinct complaint keeps the
 * queue something a person can read in a glance, which is the only reason it
 * gets read at all.
 */
export async function add(note: {
  text: string;
  session?: string | null;
  project?: string | null;
  agent?: AgentName | null;
}): Promise<Feedback> {
  const text = note.text.trim().slice(0, MAX_TEXT);
  if (!text) throw new Error("feedback text is empty");

  const existing = (await list()).find((f) => f.text === text);
  if (existing) return existing;

  const entry: Feedback = {
    id: `fb-${randomUUID().slice(0, 8)}`,
    text,
    session: note.session ?? null,
    project: note.project ?? null,
    agent: note.agent ?? null,
    at: new Date().toISOString(),
  };
  await fs.mkdir(env.FEEDBACK_DIR, { recursive: true });
  await writeJsonAtomic(filePath(entry.id), entry);
  return entry;
}

export async function remove(id: string): Promise<boolean> {
  if (!FEEDBACK_ID_RE.test(id)) return false;
  try {
    await fs.rm(filePath(id));
    return true;
  } catch {
    return false;
  }
}
