import { Cron } from "croner";
import type { Session } from "../../shared/api.js";
import { env } from "./env.js";
import { resolveInsideRepos } from "./paths.js";
import * as schedules from "./schedules-store.js";
import { REPORT_CONTRACT, createSession, getSession, listSessions } from "./sessions-store.js";
import { schedulesPaused } from "./settings-store.js";

/**
 * How many sessions may be alive before a schedule declines to add another.
 * An unattended run that quietly stacks sessions is the failure mode worth
 * engineering against: each one holds a tmux session, an agent process and a
 * share of the subscription. Pressing "run now" is subject to it too — if the
 * pod is already full, it is full.
 */
const MAX_LIVE_SESSIONS = 6;

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
 * Start the schedule's session. Skipped while its previous run is still open:
 * a slow agent must not stack a new session on every tick, and two claude
 * sessions in one repo would fight over the working tree.
 */
export async function runSchedule(id: string, log: Logger): Promise<Session | null> {
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

async function launch(id: string, log: Logger): Promise<Session | null> {
  const schedule = await schedules.getSchedule(id);
  if (!schedule) return null;
  try {
    const last = schedule.lastSessionId ? await getSession(schedule.lastSessionId) : null;
    if (last && last.status !== "done") {
      await schedules.recordRun(id, { error: `previous run ${last.id} is still open` });
      log.info(`schedule ${id} skipped: ${last.id} still open`);
      return null;
    }
    const live = (await listSessions()).filter((s) => s.status !== "done").length;
    if (live >= MAX_LIVE_SESSIONS) {
      await schedules.recordRun(id, { error: `${live} sessions already open` });
      log.info(`schedule ${id} skipped: ${live} sessions already open`);
      return null;
    }
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
    return session;
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

export function reloadSchedules(log: Logger): Promise<void> {
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
      jobs.set(
        schedule.id,
        // Named so croner registers it in its own scheduledJobs list, which is
        // the only place a timer this map has lost track of would still show up.
        new Cron(
          schedule.cron,
          { name: schedule.id, protect: true, timezone: env.TZ },
          async () => {
            // The pause switch is read at fire time, not at reload: flipping it
            // has to stop the next tick without rebuilding every timer. "Run now"
            // deliberately ignores it — that one is somebody asking.
            if (await schedulesPaused()) {
              log.info(`schedule ${schedule.id} skipped: schedules are paused`);
              return;
            }
            if (await jitter(schedule.jitterMinutes)) await runSchedule(schedule.id, log);
          },
        ),
      );
    } catch (err) {
      log.warn(err, `schedule ${schedule.id} has an unusable pattern "${schedule.cron}"`);
    }
  }
  log.info(`scheduler: ${jobs.size} active schedule(s)`);
}
