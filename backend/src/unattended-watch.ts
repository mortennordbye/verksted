import * as schedules from "./schedules-store.js";
import { readChat } from "./chat.js";
import { transcriptPath } from "./claude-home.js";
import type { Logger } from "./logger.js";
import { removeWorktree } from "./projects-store.js";
import {
  agentExited,
  endSession,
  getSession,
  lastWords,
  listSessions,
  readConv,
  sessionDir,
  writeReport,
} from "./sessions-store.js";
import * as tmux from "./tmux.js";

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
/**
 * Worktrees a build is setting up: added, but with no session of their own yet.
 *
 * For as long as the issue is claimed and the prompt written (gh alone may
 * take a minute), the only session carrying the name is the finished one
 * before it, so `held` does not see the new tree and the sweep would remove it
 * (R-04). The scheduler adds the name before the worktree and drops it once
 * the session exists or the start has failed.
 */
export const settingUp = new Set<string>();

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
        !held.has(s.project) &&
        !settingUp.has(s.project)
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

/**
 * How long a scheduled session sits quiet after a turn before it is taken to
 * have finished, and how long after being asked for its verdict before the
 * silence is recorded.
 */
export const SIGNOFF_QUIET_MS = 10 * 60_000;
/** The one line put into the pane: a newline would submit half of it. */
const SIGNOFF_ASK =
  'You have finished, but you did not write the sign-off line this run asked for. Write it now to the file at "$VK_REPORT_FILE": one line starting with ok:, attention: or failed:, then stop.';

/** When each scheduled session was asked for its verdict. In memory: a restart asks again. */
const asked = new Map<string, number>();

/**
 * Ask an ordinary scheduled session that finished for the verdict it forgot.
 *
 * A stage run exits, and vk-signoff asks it on the way out. An ordinary
 * scheduled session is a TUI that does not exit: when its turn ends the Stop
 * hook turns it amber, which is right when it stopped to ask and wrong when it
 * simply finished and did not sign off. Its conversation tells the two apart:
 * a last turn that is a question card, a plan to approve or a line ending in a
 * question mark is asking, and is left for a person. Anything else, quiet for
 * ten minutes, is asked once, in the pane; still silent ten minutes after that,
 * the silence is written as its verdict and the sweep above ends it.
 */
export async function askForSignOff(log: Logger, now = Date.now()): Promise<void> {
  for (const schedule of await schedules.listSchedules()) {
    const id = schedule.lastSessionId;
    if (!id) continue;
    const session = await getSession(id);
    if (
      !session ||
      session.unattended ||
      session.agent !== "claude" ||
      session.status !== "waiting" ||
      session.report
    ) {
      asked.delete(id);
      continue;
    }
    const quiet = session.lastActivityAt ? now - Date.parse(session.lastActivityAt) : 0;
    if (quiet < SIGNOFF_QUIET_MS) continue;
    const at = asked.get(id);
    if (at !== undefined) {
      if (now - at >= SIGNOFF_QUIET_MS) {
        await writeReport(id, "failed: no sign-off (asked, no answer)");
        asked.delete(id);
        log.info(`scheduled session ${id} did not sign off when asked`);
      }
      continue;
    }
    const conv = await readConv(id);
    if (!conv) continue;
    let file: string;
    try {
      file = transcriptPath(sessionDir(session), conv);
    } catch {
      continue;
    }
    const last = (await readChat(file, conv)).messages.filter((m) => m.role === "assistant").at(-1);
    if (!last) continue;
    if (last.ask || last.plan || /\?\s*$/.test(last.text.trim())) continue;
    await tmux.sendText(id, SIGNOFF_ASK, true);
    asked.set(id, now);
    log.info(`scheduled session ${id} finished without a verdict; asked for one`);
  }
}

/** The sweeps above, every thirty seconds, started once. */
export function startWatch(log: Logger): void {
  if (watcher) return;
  watcher = setInterval(() => {
    void watchUnattended(log).catch((err) => log.warn(err, "unattended watch failed"));
    void endSignedOffRuns(log).catch((err) => log.warn(err, "signed-off sweep failed"));
    void askForSignOff(log).catch((err) => log.warn(err, "sign-off ask failed"));
  }, WATCH_EVERY_MS);
  // A timer must not be what keeps the process alive.
  watcher.unref();
}
