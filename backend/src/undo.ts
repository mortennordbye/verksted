import type { ToolLogEntry } from "../../shared/api.js";
import { restore } from "./calendar.js";
import { relabelIds } from "./gmail.js";
import { move } from "./mail.js";
import * as mailLog from "./mail-log.js";
import * as toolLog from "./tool-log.js";

/** The call cannot be put back, and here is why, in words for the settings page. */
export class UndoRefused extends Error {}

const sameSet = (a: unknown[], b: unknown[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

/** The day before, for a call made just after midnight whose record landed just before. */
function dayBefore(day: string): string {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The mail log's record of what this call did: the newest match written before the call was logged. */
async function recordOf(day: string, entry: ToolLogEntry) {
  const records = [...(await mailLog.readDay(dayBefore(day))), ...(await mailLog.readDay(day))];
  const args = entry.args as {
    uids?: number[];
    to?: string;
    from?: string;
    query?: string;
    add?: string[];
    remove?: string[];
  };
  const matches = records.filter((r) => {
    if (r.at > entry.at) return false;
    if (entry.tool === "mail_move") {
      return (
        r.verb === "move" &&
        r.to === args.to &&
        r.from === (args.from ?? "INBOX") &&
        sameSet(r.uids, [...new Set(args.uids ?? [])])
      );
    }
    return (
      r.verb === "relabel" &&
      r.query === (args.query ?? "").trim() &&
      sameSet(r.add, [...new Set(args.add ?? [])]) &&
      sameSet(r.remove, [...new Set(args.remove ?? [])])
    );
  });
  return matches.at(-1);
}

/**
 * Put back one call the assistant made, from the settings page's log.
 *
 * Only ever the inverse of a change on record: the log line says which call,
 * and what is undone is what the mail log or the calendar's kept copy says it
 * did. A line nobody backed with a record undoes nothing. Once done it is
 * marked, so a second tap does not move the mail back again.
 */
export async function undo(day: string, at: string): Promise<string> {
  const entry = (await toolLog.readDay(day)).entries.find((e) => e.at === at);
  if (!entry) throw new UndoRefused("no such call in that day's log");
  if (entry.undo === "done") throw new UndoRefused("that has already been put back");
  if (entry.undo !== "can") throw new UndoRefused(`${entry.tool} cannot be put back from here`);

  let said: string;
  if (entry.tool === "calendar_update") {
    const uid = (entry.args as { uid?: unknown }).uid;
    if (typeof uid !== "string") throw new UndoRefused("that call names no event");
    const back = await restore(uid, entry.at);
    said = `"${back.summary}" is as it was`;
  } else {
    const record = await recordOf(day, entry);
    if (!record) throw new UndoRefused("there is no record of what that call changed");
    if (record.verb === "move") {
      const landed = Object.values(record.uidMap);
      if (!landed.length) {
        throw new UndoRefused(
          "the mail server did not say where the messages landed, so they cannot be found to move back",
        );
      }
      const n = await move(landed, record.from, { from: record.to });
      said = `${n} message${n === 1 ? "" : "s"} moved back to ${record.from}`;
    } else {
      const n = await relabelIds(record.ids, record.remove, record.add);
      said = `labels put back on ${n} message${n === 1 ? "" : "s"}`;
    }
  }
  await toolLog.markUndone(at);
  await toolLog.record({
    turn: "settings",
    speaker: "you",
    unattended: false,
    tool: "undo",
    effect: "reversible",
    args: { of: at, tool: entry.tool },
    ok: true,
    result: said,
  });
  return said;
}
