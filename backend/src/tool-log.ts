import fs from "node:fs/promises";
import path from "node:path";
import type { ToolLogDay, ToolLogEntry } from "../../shared/api.js";
import { env } from "./env.js";
import { today } from "./journal-store.js";

/**
 * What the assistant's tools actually did, one line per call.
 *
 * The thread keeps a tool's name and eighty characters of one argument, which
 * is enough for a chip on a phone and not enough for anything else: it cannot
 * answer "what did it move last night", and nothing can be put back from it.
 * This is the other record — every call that changes something, with the
 * arguments in full and what came back — appended by the MCP server through
 * `POST /api/assistant/turn/tool` as each call finishes.
 *
 * Append-only JSONL, one file per day in the bench's own timezone, because a
 * log that can be rewritten is not one. Reads are left out on purpose: a
 * personal assistant reads the mail and the calendar all day, and a record of
 * that is a second copy of the person's life rather than an audit trail.
 */
export function toolLogDir(): string {
  return path.join(env.ASSISTANT_DIR, "tool-log");
}

/** What the tool answered is evidence, not content: a line, not a page. */
const MAX_RESULT = 500;

/**
 * Past this, the arguments are dropped rather than the line: a record that
 * says a call was made and cannot be read is still worth more than no record,
 * and a JSONL file of megabyte lines is worth less than one.
 */
const MAX_LINE = 16 * 1024;

export async function record(entry: Omit<ToolLogEntry, "at">, now = new Date()): Promise<void> {
  const full: ToolLogEntry = {
    at: now.toISOString(),
    ...entry,
    result: entry.result.slice(0, MAX_RESULT),
  };
  let line = JSON.stringify(full);
  if (line.length > MAX_LINE) {
    line = JSON.stringify({
      ...full,
      args: { dropped: `${JSON.stringify(full.args).length} bytes` },
    });
  }
  await fs.mkdir(toolLogDir(), { recursive: true });
  // O_APPEND: two advisors of a council meeting write this file at once, and a
  // line either lands whole or does not land.
  await fs.appendFile(path.join(toolLogDir(), `${today(now)}.jsonl`), `${line}\n`);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The calls the log can put back, and what each is put back from: a move from
 * the uids the mail log has for where the messages landed, a relabel from the
 * message ids it touched, a calendar change from the copy kept before it.
 * Cards are not here: what a tapped card did is not a line of this log.
 */
export const UNDOABLE = new Set(["mail_move", "mail_relabel", "calendar_update"]);

/** Which calls have been put back, by the `at` of the call. Not a `.jsonl`, so never a day. */
function undonePath(): string {
  return path.join(toolLogDir(), "undone.json");
}

export async function readUndone(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(undonePath(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export async function markUndone(at: string, now = new Date()): Promise<void> {
  const undone = await readUndone();
  undone[at] = now.toISOString();
  await fs.mkdir(toolLogDir(), { recursive: true });
  await fs.writeFile(undonePath(), JSON.stringify(undone));
}

/**
 * One day of the log as the settings page reads it, and which days there are.
 * No day means the newest one. A day is only ever a date, so the file it names
 * cannot be anything but a day's log. A line that does not parse costs that
 * line: a half-written last line is what a crash mid-append leaves.
 */
export async function readDay(day?: string): Promise<ToolLogDay> {
  const days = (await fs.readdir(toolLogDir()).catch(() => []))
    .filter((f) => f.endsWith(".jsonl") && DAY_RE.test(f.slice(0, -6)))
    .map((f) => f.slice(0, -6))
    .sort()
    .reverse();
  const shown = day ?? days[0] ?? null;
  if (!shown || !DAY_RE.test(shown)) return { days, day: shown, entries: [] };
  const text = await fs.readFile(path.join(toolLogDir(), `${shown}.jsonl`), "utf8").catch(() => "");
  const entries: ToolLogEntry[] = [];
  const undone = await readUndone();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as ToolLogEntry;
      if (entry.ok && UNDOABLE.has(entry.tool)) entry.undo = undone[entry.at] ? "done" : "can";
      entries.push(entry);
    } catch {
      // See above.
    }
  }
  return { days, day: shown, entries };
}
