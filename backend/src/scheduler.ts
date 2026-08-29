import { Cron } from "croner";
import type { Schedule, Session } from "../../shared/api.js";
import { MAX_CONVENED, runUnattended } from "./assistant.js";
import { env } from "./env.js";
import { syncDefaultBranch } from "./git.js";
import { claimIssue, pickIssue, readContract, stagePrompt } from "./maintainer.js";
import { resolveInsideRepos } from "./paths.js";
import { addWorktree, removeWorktree } from "./projects-store.js";
import * as schedules from "./schedules-store.js";
import {
  REPORT_CONTRACT,
  agentExited,
  createSession,
  endSession,
  getSession,
  lastWords,
  listSessions,
  writeReport,
} from "./sessions-store.js";
import { execEnv, schedulesPaused } from "./settings-store.js";

/**
 * How many sessions may be alive before a schedule declines to add another.
 * An unattended run that quietly stacks sessions is the failure mode worth
 * engineering against: each one holds a tmux session, an agent process and a
 * share of the subscription. Pressing "run now" is subject to it too — if the
 * pod is already full, it is full.
 */
const MAX_LIVE_SESSIONS = 6;

/**
 * How many unattended assistant turns may start in one day, across every
 * schedule.
 *
 * The session ceiling above does not bind these: a briefing holds no tmux and
 * no working tree, so nothing else would notice a schedule set to `* * * * *`
 * quietly making 1440 model calls a day against a subscription. This is the
 * backstop for that — not a budget for normal use, which is three or four.
 *
 * In memory, and reset by a restart. That is the right trade for a backstop:
 * the failure it guards against is a runaway loop within one day, and a file on
 * the volume to survive a reboot would be state kept for nothing.
 */
const MAX_UNATTENDED_PER_DAY = 12;
let unattendedDay = "";
let unattendedToday = 0;

/**
 * True when today's ceiling is already spent; counts the turns when it is not.
 *
 * Turns rather than runs, because a briefing that convenes the council is
 * several model calls wearing one schedule's name. A ceiling that counted runs
 * would let twelve meetings be forty-eight calls, and a backstop that stops
 * counting the thing it is backstopping is worse than none.
 *
 * `n` is what the run is about to spend at most: one for a solo briefing, and
 * for a meeting the chair's two turns plus everyone it might convene. Reserved
 * up front rather than charged as it goes, because a meeting that runs out
 * halfway has already spent the expensive half and has nothing to show for it.
 */
function overDailyCeiling(n = 1): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== unattendedDay) {
    unattendedDay = day;
    unattendedToday = 0;
  }
  if (unattendedToday + n > MAX_UNATTENDED_PER_DAY) return true;
  unattendedToday += n;
  return false;
}

/**
 * Hand back what a meeting did not spend.
 *
 * The reservation is for the worst case — the chair may convene nobody, or
 * fewer than the roster — and a budget that only ever went down would make a
 * quiet morning cost as much as a busy one.
 */
function refundCeiling(n: number): void {
  unattendedToday = Math.max(0, unattendedToday - n);
}

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

const jobs = new Map<string, Cron>();
/** Cancels for jitter waits in flight, so a reload doesn't leave one hanging. */
const waits = new Set<() => void>();

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sleep a random slice of the schedule's jitter window. Resolves false when a
 * reload cancelled the wait — the schedule changed under it, so the run that
 * was waiting is no longer the one to start.
 */
function jitter(minutes: number): Promise<boolean> {
  if (minutes <= 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        waits.delete(cancel);
        resolve(true);
      },
      Math.random() * minutes * 60_000,
    );
    const cancel = () => {
      clearTimeout(timer);
      waits.delete(cancel);
      resolve(false);
    };
    waits.add(cancel);
  });
}

/**
 * Schedules with a launch in flight.
 *
 * The "still open" check below reads lastSessionId, which is only written once
 * createSession has returned — and createSession syncs the default branch and
 * spawns tmux before it does. Anything firing inside that window (a tick, a
 * "run now" pressed while one is already starting, a duplicate timer) reads the
 * same stale "nothing is open" and starts a second agent in the same worktree.
 *
 * Added to synchronously, before the first await, so two calls in one turn of
 * the event loop cannot both get past it.
 */
const starting = new Set<string>();

/**
 * What a firing produced. A session schedule starts an agent you can attach to;
 * an assistant schedule produces a line of text and nothing else. Null is the
 * third case, and the interesting one: it declined, and said why in the run log.
 */
export type RunOutcome = { session: Session } | { reply: string };

/**
 * Start the schedule's session. Skipped while its previous run is still open:
 * a slow agent must not stack a new session on every tick, and two claude
 * sessions in one repo would fight over the working tree.
 */
export async function runSchedule(id: string, log: Logger): Promise<RunOutcome | null> {
  if (starting.has(id)) {
    log.info(`schedule ${id} skipped: a run is already starting`);
    await schedules.recordRun(id, { error: "a run is already starting" });
    return null;
  }
  starting.add(id);
  try {
    return await launch(id, log);
  } finally {
    starting.delete(id);
  }
}

/**
 * Whether this tick should be dropped for want of anything to look at.
 *
 * A pass over what happened has nothing to read when nothing happened, and the
 * turn that discovers that costs the same as one that finds something. The
 * window matches what `recent_prompts` reads by default.
 *
 * Exported so the rule is testable on its own: it is consulted from inside a
 * cron callback, which is the one place in this module a test cannot reach
 * without waiting for a real minute to pass.
 */
export async function skipForIdle(schedule: Schedule): Promise<boolean> {
  if (!schedule.skipWhenIdle) return false;
  const since = Date.now() - 24 * 60 * 60_000;
  return !(await listSessions()).some((s) => s.endedAt && Date.parse(s.endedAt) >= since);
}

/**
 * An assistant firing: one unattended turn, and what it said is the report.
 *
 * None of the session ceilings apply — it starts no session, holds no tmux and
 * touches no working tree. What bounds it instead is that only one unattended
 * turn runs at a time, which `runUnattended` refuses past.
 */
async function briefing(id: string, schedule: Schedule, log: Logger): Promise<RunOutcome | null> {
  // Reserved for the worst case this run could cost: the chair's two turns plus
  // everyone it might convene. Anything it does not use is handed back below.
  const reserved = schedule.convenes ? MAX_CONVENED + 2 : 1;
  if (overDailyCeiling(reserved)) {
    await schedules.recordRun(id, {
      error: `${MAX_UNATTENDED_PER_DAY} unattended turns already ran today`,
    });
    log.warn({ schedule: id }, `schedule ${id} skipped: daily unattended ceiling reached`);
    return null;
  }
  const { text, failed, turns } = await runUnattended(
    schedule.prompt,
    schedule.member,
    schedule.convenes,
  );
  refundCeiling(reserved - turns);
  if (failed || !text) {
    const error = text || "the turn produced nothing";
    await schedules.recordRun(id, { error });
    log.warn({ schedule: id }, `assistant schedule ${id} failed: ${error}`);
    return null;
  }
  await schedules.recordRun(id, { reply: text });
  log.info(`assistant schedule ${id} replied`);
  return { reply: text };
}

/**
 * Whether a session schedule may start one now: not while its previous run is
 * still open, and not on a pod that is already full. Records the refusal.
 */
async function roomForSession(id: string, schedule: Schedule, log: Logger): Promise<boolean> {
  const last = schedule.lastSessionId ? await getSession(schedule.lastSessionId) : null;
  if (last && last.status !== "done") {
    await schedules.recordRun(id, { error: `previous run ${last.id} is still open` });
    log.info(`schedule ${id} skipped: ${last.id} still open`);
    return false;
  }
  const live = (await listSessions()).filter((s) => s.status !== "done").length;
  if (live >= MAX_LIVE_SESSIONS) {
    await schedules.recordRun(id, { error: `${live} sessions already open` });
    log.info(`schedule ${id} skipped: ${live} sessions already open`);
    return false;
  }
  return true;
}

/**
 * A maintainer stage: the shipped prompt for it, the repo's own contract, and
 * a session that cannot ask. Bounded by the session ceilings like any other
 * session schedule, and deliberately not by the daily turn ceiling: that one
 * exists for runs that hold no session, and three repos running three stages
 * a night would otherwise use it up and start dropping the morning briefing.
 */
async function stageRun(id: string, schedule: Schedule, log: Logger): Promise<RunOutcome | null> {
  const stage = schedule.stage!;
  const repoDir = resolveInsideRepos(schedule.project);
  const contract = await readContract(repoDir);
  if (stage !== "build") {
    const prompt = await stagePrompt(
      stage,
      { project: schedule.project, dir: repoDir, contract },
      schedule.prompt,
    );
    const session = await createSession(schedule.project, repoDir, "claude", {
      title: schedule.name,
      prompt: prompt + REPORT_CONTRACT,
      unattended: stage,
    });
    await schedules.recordRun(id, { sessionId: session.id });
    log.info(`schedule ${id} started ${stage} session ${session.id}`);
    return { session };
  }

  // A build works in a worktree of its own, branched from an up-to-date
  // default branch, so the repo itself stays where the person left it. The
  // sync happens here because createSession skips it for a worktree.
  await syncDefaultBranch(repoDir, await execEnv());
  const issue = await pickIssue(repoDir);
  if (!issue) {
    await schedules.recordRun(id, { error: "queue empty" });
    log.info(`schedule ${id} skipped: nothing queued`);
    return null;
  }
  const wt = await addWorktree(schedule.project, `maint/${issue.number}`);
  // Claimed only once the worktree exists: a failed add leaves it queued.
  await claimIssue(repoDir, issue.number);
  const prompt = await stagePrompt(
    stage,
    { project: schedule.project, dir: wt.dir, contract },
    schedule.prompt,
    issue,
  );
  const session = await createSession(wt.name, wt.dir, "claude", {
    title: `${schedule.name} · #${issue.number}`,
    prompt: prompt + REPORT_CONTRACT,
    unattended: stage,
    issue: issue.number,
  });
  await schedules.recordRun(id, { sessionId: session.id });
  log.info(`schedule ${id} started build session ${session.id} for #${issue.number}`);
  return { session };
}

async function launch(id: string, log: Logger): Promise<RunOutcome | null> {
  const schedule = await schedules.getSchedule(id);
  if (!schedule) return null;
  try {
    if (schedule.kind === "assistant") return await briefing(id, schedule, log);
    if (!(await roomForSession(id, schedule, log))) return null;
    if (schedule.stage) return await stageRun(id, schedule, log);
    const session = await createSession(
      schedule.project,
      resolveInsideRepos(schedule.project),
      "claude",
      {
        title: schedule.name,
        prompt: schedule.prompt + REPORT_CONTRACT,
        autoPermissions: true,
      },
    );
    await schedules.recordRun(id, { sessionId: session.id });
    log.info(`schedule ${id} started session ${session.id}`);
    return { session };
  } catch (err) {
    // A deleted project, a tmux that would not start: record it for the UI
    // rather than letting it escape into an unhandled rejection.
    await schedules.recordRun(id, { error: reason(err) });
    log.warn(err, `schedule ${id} failed`);
    return null;
  }
}

/**
 * Rebuild every timer from the stored schedules. Called at boot and after any
 * change to them — cheap enough (a handful of records) not to need diffing.
 *
 * Serialized, because rebuild() clears the map before an await and fills it
 * after. Two overlapping calls — two edits saved together, or one landing while
 * the boot reload is still running — would therefore both clear the map before
 * either had filled it, leaving the first call's Cron objects unreferenced and
 * still firing. Nothing can stop them after that: the schedule ticks twice, and
 * a schedule disabled by the very edit that triggered the reload keeps running,
 * because runSchedule is reached through a timer that no longer exists as far
 * as the map is concerned.
 */
let reloading: Promise<void> = Promise.resolve();

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
  for (const s of await listSessions()) {
    if (!s.unattended) continue;
    if (s.status === "done") {
      // A build's worktree has done its job once the session is over and
      // everything in it reached the remote; what is left is the pull request.
      // One with unpushed or uncommitted work is left for a person to read.
      if (s.unattended === "build" && s.work && s.work.dirty === 0 && !s.work.unpushed) {
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

export function reloadSchedules(log: Logger): Promise<void> {
  if (!watcher) {
    watcher = setInterval(() => {
      void watchUnattended(log).catch((err) => log.warn(err, "unattended watch failed"));
    }, WATCH_EVERY_MS);
    // A timer must not be what keeps the process alive.
    watcher.unref();
  }
  const run = reloading.then(
    () => rebuild(log),
    () => rebuild(log),
  );
  reloading = run.catch(() => {});
  return run;
}

async function rebuild(log: Logger): Promise<void> {
  for (const job of jobs.values()) job.stop();
  jobs.clear();
  for (const cancel of [...waits]) cancel();
  for (const schedule of await schedules.listSchedules()) {
    if (!schedule.enabled) continue;
    try {
      // protect: croner skips a tick whose predecessor is still running — which
      // includes one still sitting out its jitter.
      // Named so croner registers it in its own scheduledJobs list, which is
      // the only place a timer this map has lost track of would still show up.
      const job = new Cron(
        schedule.cron,
        { name: schedule.id, protect: true, timezone: env.TZ },
        () => fire(schedule, log),
      );
      jobs.set(schedule.id, job);
      catchUp(schedule, job, log);
    } catch (err) {
      log.warn(err, `schedule ${schedule.id} has an unusable pattern "${schedule.cron}"`);
    }
  }
  log.info(`scheduler: ${jobs.size} active schedule(s)`);
}

/** One firing of a timer: everything a tick does once the clock has spoken. */
async function fire(schedule: Schedule, log: Logger): Promise<void> {
  // Stamped first, and regardless of what the checks below decide. Every one of
  // them is the schedule declining on purpose, and a boot that could not tell
  // those from a tick nobody was up for would re-run them.
  await schedules.stampFired(schedule.id);
  // The pause switch is read at fire time, not at reload: flipping it has to
  // stop the next tick without rebuilding every timer. "Run now" deliberately
  // ignores it — that one is somebody asking.
  if (await schedulesPaused()) {
    log.info(`schedule ${schedule.id} skipped: schedules are paused`);
    return;
  }
  // Beside the pause switch rather than inside runSchedule, because "run now"
  // is somebody asking and is subject to neither.
  if (await skipForIdle(schedule)) {
    log.info(`schedule ${schedule.id} skipped: nothing ended in the last day`);
    return;
  }
  if (await jitter(schedule.jitterMinutes)) await runSchedule(schedule.id, log);
}

/**
 * How late a tick may be and still be worth running. A 07:00 briefing read at
 * 07:20 is the morning's; the same one at lunchtime is yesterday's news, and
 * tomorrow's is coming anyway.
 */
const CATCH_UP_WITHIN_MS = 60 * 60_000;

/**
 * When this process came up. A tick due after it was not missed for want of a
 * pod — this one was here — so it was dropped by croner's `protect` (a run
 * still going, jitter included) or by a reload replacing the timers mid-tick.
 * Both are deliberate, and re-running them is exactly the stacking the ceilings
 * elsewhere in this file exist to prevent.
 */
const startedAt = Date.now();

/** What a boot should do about a tick a schedule may have missed. */
export type Catchup = "nothing" | "catch up" | "too late";

/**
 * The rule, on its own so it is testable without waiting for a real minute to
 * pass — the same reason skipForIdle is exported.
 *
 * `due` is the first cron occurrence after the schedule last fired, and `after`
 * the one following it, which is the schedule's own interval measured at the
 * point it matters. A schedule that has never fired has nothing to compare
 * against and is left alone: that is a schedule added moments ago, and — the
 * first time this ships — every schedule there is.
 */
export function missedTick(
  lastFiredAt: string | null,
  due: Date | null,
  after: Date | null,
  now: number,
): Catchup {
  if (!lastFiredAt || !due) return "nothing";
  const at = due.getTime();
  if (at > now || at >= startedAt) return "nothing";
  // Half the interval, so a frequent schedule waits for the tick it is about to
  // get rather than firing one a minute ahead of it.
  const window = after
    ? Math.min(CATCH_UP_WITHIN_MS, (after.getTime() - at) / 2)
    : CATCH_UP_WITHIN_MS;
  return now - at <= window ? "catch up" : "too late";
}

/**
 * Run, or write off, the tick this schedule missed while the pod was down.
 *
 * Timers live only in memory and are rebuilt from the stored records at boot,
 * so a restart spanning 07:00 loses that firing with nothing left to say it
 * ever should have happened. That silence is the real cost: an unattended run
 * that reports itself ok is *meant* to leave the inbox quiet, so a scheduler
 * that never fired reads exactly like a night when all was well.
 *
 * Not awaited by the rebuild that starts it — a catch-up sits out its jitter
 * and then runs an agent, and the schedules behind it in the loop should not
 * wait for that to get their timers.
 */
function catchUp(schedule: Schedule, job: Cron, log: Logger): void {
  const last = schedule.lastFiredAt;
  const due = last ? job.nextRun(new Date(last)) : null;
  const verdict = missedTick(last, due, due && job.nextRun(due), Date.now());
  if (verdict === "nothing") return;

  const at = due!.toISOString();
  if (verdict === "too late") {
    log.warn({ schedule: schedule.id }, `schedule ${schedule.id} missed its ${at} tick`);
    // Stamped as well as recorded, so the tick is accounted for: without it a
    // pod that keeps restarting would report the same missed tick every boot
    // until it had pushed the schedule's real history out of the run list.
    // Strictly after the record, never beside it: both rewrite the same file
    // from what they read, so in parallel the later write drops the other's.
    void schedules
      .recordRun(schedule.id, { error: `missed while the pod was down (due ${at})` })
      .then(() => schedules.stampFired(schedule.id))
      .catch((err) => log.warn(err, `recording ${schedule.id}'s missed tick failed`));
    return;
  }

  log.info(`schedule ${schedule.id} catching up on its ${at} tick`);
  void fire(schedule, log).catch((err) => log.warn(err, `catch-up for ${schedule.id} failed`));
}
