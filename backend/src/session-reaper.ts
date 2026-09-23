import fs from "node:fs/promises";
import path from "node:path";
import type { Session } from "../../shared/api.js";
import { env } from "./env.js";
import type { Logger } from "./logger.js";
import {
  captureWork,
  convPath,
  endSession,
  exitPath,
  liveNames,
  metaPath,
  readAll,
  readState,
  reportPath,
  statePath,
  toSession,
} from "./sessions-store.js";

/**
 * Ending what nobody will come back to: a finished agent's bare shell, and
 * history past its retention, moved to the archive. Out of sessions-store.ts
 * (R-34).
 */

/**
 * How long a session has to have been a bare shell before the sweep ends it.
 * Long enough that a pane still being read is never pulled out from under
 * someone, short enough that a night of finished runs is not still holding
 * slots the scheduler needs in the morning.
 */
export const REAP_IDLE_MS = 2 * 60 * 60_000;

/**
 * Whether the agent this pane was started for has exited.
 *
 * tmux runs the agent as `<agent>; exec $SHELL`, so the pane process is the
 * shell in both cases and its command name says nothing (see SessionActivity).
 * What says everything is the child: while the agent runs — including while it
 * is running a tool — the shell has one, and when it exits the pane is left as
 * an interactive shell with none.
 */
async function agentGone(panePid: number): Promise<boolean> {
  try {
    const children = await fs.readFile(`/proc/${panePid}/task/${panePid}/children`, "utf8");
    return children.trim() === "";
  } catch {
    // No such process, or a kernel without CONFIG_PROC_CHILDREN. Neither is
    // evidence that the agent is gone, and this decision ends sessions.
    return false;
  }
}

/**
 * End sessions whose agent has finished and left the pane sitting at a shell.
 *
 * These are invisible as anything but "running": the pane outlives the agent on
 * purpose (a crashed agent has to stay readable, and its shell is where you
 * restart it), so a session whose work ended at 02:00 still reads as live at
 * noon and still counts against the scheduler's live-session ceiling. Ending it
 * here is the same end DELETE performs — the report, the commit range and the
 * history all survive; only the idle pane goes.
 *
 * Deliberately narrow. Nothing is ended that is:
 *
 * - **waiting** — that is a question addressed to a person, and the inbox's
 *   business, not a sweep's.
 * - **still running an agent** — a live child means work in progress, however
 *   quiet the pane has been.
 * - **holding uncommitted or unpushed work** — the volume is the only copy, and
 *   discarding what git cannot get back is not a housekeeping decision. Those
 *   are reported instead, and left exactly where they are.
 */
export async function reapFinishedSessions(log: Logger): Promise<string[]> {
  const live = await liveNames();
  if (live === null) return []; // tmux unreachable: sweep nothing, as elsewhere.
  const ended: string[] = [];
  for (const meta of await readAll()) {
    if (meta.endedAt) continue;
    const activity = live.get(meta.id);
    if (!activity) continue; // Already gone; the list sweep stamps its end.
    if (Date.now() - activity.activity * 1000 < REAP_IDLE_MS) continue;
    if ((await readState(meta.id)) === "waiting") continue;
    if (!(await agentGone(activity.panePid))) continue;

    const { work } = await captureWork(meta);
    if (work && (work.dirty > 0 || (work.unpushed ?? 0) > 0)) {
      log.warn(
        { session: meta.id, dirty: work.dirty, unpushed: work.unpushed },
        `${meta.id} finished with work only on the volume; leaving it open`,
      );
      continue;
    }
    await endSession(meta.id);
    ended.push(meta.id);
    const idleHours = Math.round((Date.now() - activity.activity * 1000) / 3_600_000);
    log.info(`ended ${meta.id}: its agent had exited, pane idle ${idleHours}h`);
  }
  return ended;
}

/**
 * How long a finished session stays a file of its own in the sessions
 * directory.
 *
 * Everything that reads sessions walks that directory: the sweeper every five
 * seconds, the notifier every five, the scheduler twice a minute, and every
 * list. Nothing prunes it, so the walk grows with everything that ever ran —
 * a pod three years old would be stepping over thousands of finished runs to
 * find the two that are live.
 *
 * Three months is well past the point where a run is something anyone opens,
 * and comfortably past the thirty days the usage page breaks down by project.
 */
export const RETAIN_DAYS = 90;

function archiveDir(): string {
  return path.join(env.SESSIONS_DIR, "archive");
}

/**
 * Retire the sessions that ended long enough ago, keeping what they cost.
 *
 * Archived, not deleted. The row itself is small and the usage page adds up
 * every month there has ever been, so throwing it away would make last year
 * read as a year of nothing. What goes is the per-session file and its
 * sidecars — the verdict, the exit code, the conversation id, the read marks —
 * which is what the walk is made of. The transcript is not here at all: it
 * lives in the agent's own home directory and is untouched by this.
 *
 * Written before the metadata is removed, and read back deduplicated by id, so
 * a crash between the two costs a repeated row rather than a lost one.
 */
export async function archiveOldSessions(log: Logger): Promise<number> {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60_000;
  let n = 0;
  for (const meta of await readAll()) {
    const endedAt = meta.endedAt ? Date.parse(meta.endedAt) : NaN;
    // Not finished, or not finished long enough ago. An unparseable endedAt is
    // not evidence of age, and this removes files.
    if (!Number.isFinite(endedAt) || endedAt > cutoff) continue;
    const row = await toSession(meta, false, null);
    await fs.mkdir(archiveDir(), { recursive: true });
    // The month from the timestamp, never from the string it was parsed out
    // of. `Date.parse` takes "3/14/2026" as readily as an ISO date, and the
    // first seven characters of that are a path of their own.
    const month = new Date(endedAt).toISOString().slice(0, 7);
    await fs.appendFile(path.join(archiveDir(), `${month}.jsonl`), `${JSON.stringify(row)}\n`);
    // The metadata first: it is what the session is listed from, so once it is
    // gone the session is retired whatever happens to the rest.
    for (const file of [metaPath, statePath, convPath, reportPath, exitPath]) {
      await fs.rm(file(meta.id), { force: true });
    }
    n++;
  }
  if (n) log.info(`archived ${n} session(s) that ended more than ${RETAIN_DAYS} days ago`);
  return n;
}

/**
 * The sessions that have been retired, as they were when they were.
 *
 * Only the usage page asks: it adds up every month there has ever been, and
 * those totals are the one thing that would quietly change if history simply
 * stopped at ninety days.
 */
export async function archivedSessions(): Promise<Session[]> {
  const files = await fs.readdir(archiveDir()).catch(() => [] as string[]);
  const byId = new Map<string, Session>();
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const text = await fs.readFile(path.join(archiveDir(), f), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Session;
        // Last write wins, and a row repeated by a crash mid-retirement counts
        // once rather than twice.
        if (row?.id) byId.set(row.id, row);
      } catch {
        // One unreadable line is one session's row, not the whole archive.
      }
    }
  }
  return [...byId.values()];
}
