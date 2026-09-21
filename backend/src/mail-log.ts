import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";
import { today } from "./journal-store.js";

/**
 * Where the mail went, one line per move or relabel (A-09).
 *
 * "Undone by moving them back" was the reason filing needs no card, and
 * nothing recorded where a message had been put or what it is called there: a
 * moved message gets a new uid in its new folder, and a relabel names a search
 * whose results change by the hour. This keeps what an undo would be replayed
 * from. The tool log beside it has the arguments; only the mail code knows
 * what the server answered.
 *
 * Append-only JSONL, a file per day in the bench's zone, like the tool log.
 */
export function mailLogDir(): string {
  return path.join(env.ASSISTANT_DIR, "mail-log");
}

export type MailLogEntry =
  | {
      verb: "move";
      from: string;
      to: string;
      uids: number[];
      /** Old uid to the uid it has in `to`; empty on a server without UIDPLUS. */
      uidMap: Record<string, number>;
    }
  | { verb: "relabel"; query: string; ids: string[]; add: string[]; remove: string[] };

export async function record(entry: MailLogEntry, now = new Date()): Promise<void> {
  await fs.mkdir(mailLogDir(), { recursive: true });
  await fs.appendFile(
    path.join(mailLogDir(), `${today(now)}.jsonl`),
    `${JSON.stringify({ at: now.toISOString(), ...entry })}\n`,
  );
}
