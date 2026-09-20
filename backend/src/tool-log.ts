import fs from "node:fs/promises";
import path from "node:path";
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

export interface ToolLogEntry {
  at: string;
  /** The CLI run the call belongs to, which is what a prompt injection acts within. */
  turn: string;
  /** The chair, or the advisor whose turn it was. */
  speaker: string;
  /** A turn nobody was reading. */
  unattended: boolean;
  tool: string;
  /** From the tool policy table: reversible, card or irreversible. */
  effect: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** What the tool answered, or why it did not. Trimmed: the line is the record, not the reply. */
  result: string;
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
