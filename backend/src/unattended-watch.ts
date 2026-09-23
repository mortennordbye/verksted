import * as schedules from "./schedules-store.js";
import type { Logger } from "./logger.js";
import { removeWorktree } from "./projects-store.js";
import {
  agentExited,
  endSession,
  getSession,
  lastWords,
  listSessions,
  writeReport,
} from "./sessions-store.js";

/**
 * How long an unattended run may hold a session before it is ended for it.
 * A scout is minutes; this is for the one that never finishes, at an hour
 * that nobody is going to notice it not finishing.
 */
export const UNATTENDED_CAP_MS = 90 * 60_000;

const WATCH_EVERY_MS = 30_000;
let watcher: NodeJS.Timeout | undefined;

/**
 * End the unattended sessions that are over, and the ones that should be.
 *
 * A headless agent exits on its own, but its pane keeps a shell after it, so
 * tmux still lists the session and — as every schedule refuses to overlap
 * itself — the next tick would be skipped for a run that finished hours ago.
 * The Stop hook writes a report when the agent left none; this is the backstop
 * for that too, so silence never masquerades as a night that went well. Kept
 * free of per-run state so a restart changes nothing about it.
 */
export async function watchUnattended(log: Logger, now = Date.now()): Promise<void> {
  const sessions = await listSessions();
  // The working trees somebody is in right now. A build's worktree is named
  // for its issue (`<repo>--maint-<number>`), so an issue put back in the
  // queue is built in a directory with the name the finished session still
  // carries — and this sweep, which runs every thirty seconds forever, would
  // force-remove it under the live run (R-04).
  const held = new Set(sessions.filter((s) => s.status !== "done").map((s) => s.project));
  for (const s of sessions) {
    if (!s.unattended) continue;
    if (s.status === "done") {
      // A build's worktree has done its job once the session is over and
      // everything in it reached the remote; what is left is the pull request.
      // One with unpushed or uncommitted work is left for a person to read.
      if (
        s.unattended === "build" &&
        s.work &&
        s.work.dirty === 0 &&
        !s.work.unpushed &&
        !held.has(s.project)
      ) {
        await removeWorktree(s.project)
          .then(() => log.info(`removed worktree ${s.project} after ${s.id}`))
          .catch(() => {
            // Already gone, or not a worktree: nothing to do.
          });
      }
      continue;
    }
    const code = await agentExited(s.id);
    if (code !== null) {
      if (!s.report) {
        // The Stop hook should have written this; that it did not usually
        // means claude never started, and the pane has the reason.
        const { line, tail } = await lastWords(s.id);
        const why = [`exit ${code}`, line ? `last line: ${line}` : ""].filter(Boolean).join(", ");
        await writeReport(s.id, `failed: no sign-off (${why})`, tail);
      }
      await endSession(s.id);
      log.info(`unattended session ${s.id} ended: ${s.report ?? "no sign-off"}`);
    } else if (now - Date.parse(s.createdAt) > UNATTENDED_CAP_MS) {
      await writeReport(s.id, `failed: killed after ${UNATTENDED_CAP_MS / 60_000} minutes`);
      await endSession(s.id);
      log.warn({ session: s.id }, `unattended session ${s.id} killed at the cap`);
    }
  }
}

/**
 * End a scheduled session that has signed off.
 *
 * A schedule's own session runs the TUI rather than a headless agent: it writes
 * its report and then sits at the prompt, because nothing tells it the run is
 * over. tmux keeps listing it, the schedule refuses to overlap itself, and the
 * next night is skipped for a run that finished at 02:00 — which is how one
 * lapsed login cost three nights of renders. This is the mechanical half of
 * what the tidy-up assistant did by hand, and the half that has to keep working
 * when the assistant itself cannot authenticate.
 *
 * Only the session each schedule is waiting on, and only once it has written a
 * verdict: a run that stopped to ask something has no report and is left where
 * it is, which is what the amber chip is for. Writing the report is the agent
 * saying it is done, so a person who wants to carry on from there starts a
 * session of their own.
 */
export async function endSignedOffRuns(log: Logger): Promise<void> {
  for (const schedule of await schedules.listSchedules()) {
    const id = schedule.lastSessionId;
    if (!id) continue;
    const session = await getSession(id);
    // Unattended runs are watchUnattended's; it ends them on the agent's exit.
    if (!session || session.unattended || session.status === "done" || !session.report) continue;
    await endSession(id);
    log.info(`scheduled session ${id} ended: ${session.report}`);
  }
}

/** The sweep above and the one below, every thirty seconds, started once. */
export function startWatch(log: Logger): void {
  if (watcher) return;
  watcher = setInterval(() => {
    void watchUnattended(log).catch((err) => log.warn(err, "unattended watch failed"));
    void endSignedOffRuns(log).catch((err) => log.warn(err, "signed-off sweep failed"));
  }, WATCH_EVERY_MS);
  // A timer must not be what keeps the process alive.
  watcher.unref();
}
