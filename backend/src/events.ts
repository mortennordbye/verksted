import { listProjects } from "./projects-store.js";
import * as store from "./sessions-store.js";

/**
 * One server-side watcher feeding every connected client, instead of every
 * client asking on its own timer.
 *
 * What the UI polled for is the same answer for everyone: the session list and
 * the project list. Each open screen used to ask for both every five seconds,
 * and `/api/projects` alone spawns three git processes per repo — so ten repos
 * in two tabs was sixty processes a minute to learn that nothing had changed,
 * and on a phone it kept the radio awake for it.
 *
 * Here the work happens once per interval no matter how many clients are
 * attached, and a client hears about it only when the answer actually differs
 * from the last one it was sent. With nobody connected nothing runs at all,
 * which is strictly less than the old floor.
 *
 * Deliberately not hooks: "finished" means the tmux session died, and no hook
 * can report its own death. This is the same reason the notifier polls, and the
 * two loops stay separate — the notifier has to keep running with no browser
 * open at all.
 */

export type Topic = "sessions" | "projects";

type Send = (topic: Topic, json: string) => void;

/** How often each answer is recomputed while anyone is listening. */
const INTERVALS: Record<Topic, number> = {
  // Status is what a badge is watching; this is the number that decides how
  // quickly "waiting" shows up after an agent asks for something.
  sessions: 3_000,
  // Three git processes per repo. Branch and dirtiness move on human timescales.
  projects: 10_000,
};

const SOURCES: Record<Topic, () => Promise<unknown>> = {
  sessions: () => store.listSessions(),
  projects: () => listProjects(),
};

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

const clients = new Set<Send>();
/** Last payload broadcast per topic — both the change test and what a joining
 *  client is handed so it need not fetch the same thing over again. */
const latest = new Map<Topic, string>();
const timers = new Map<Topic, NodeJS.Timeout>();
let log: Logger = { warn: () => {} };

const TOPICS = Object.keys(INTERVALS) as Topic[];

/** Topics being computed right now, and those asked for again meanwhile. */
const running = new Set<Topic>();
const again = new Set<Topic>();

/**
 * One computation per topic at a time. Two overlapping ones could finish out of
 * order, and the older answer, broadcast last, would put a repo that had just
 * gone clean back to "dirty" on every screen.
 */
async function tick(topic: Topic): Promise<void> {
  if (running.has(topic)) {
    again.add(topic);
    return;
  }
  running.add(topic);
  try {
    const json = JSON.stringify(await SOURCES[topic]());
    if (latest.get(topic) !== json) {
      latest.set(topic, json);
      for (const send of clients) send(topic, json);
    }
  } catch (err) {
    // A repo deleted mid-scan, or tmux briefly unavailable. Say nothing and try
    // again next interval: clients keep the last good answer, which beats
    // pushing an error into a status badge.
    log.warn(err, `event source failed: ${topic}`);
  } finally {
    running.delete(topic);
  }
  if (again.delete(topic) && timers.has(topic)) await tick(topic);
}

/**
 * Recompute a topic now rather than at its next interval: after a pull, reset
 * or commit, so "dirty" follows the repo instead of lagging it. Nothing runs
 * while nobody is listening.
 */
export function refreshTopic(topic: Topic): void {
  if (timers.has(topic)) void tick(topic);
}

function startTimers(): void {
  for (const topic of TOPICS) {
    if (timers.has(topic)) continue;
    const timer = setInterval(() => void tick(topic), INTERVALS[topic]);
    // The watcher must never be the reason the process stays up.
    timer.unref?.();
    timers.set(topic, timer);
    void tick(topic);
  }
}

function stopTimers(): void {
  for (const [topic, timer] of timers) {
    clearInterval(timer);
    timers.delete(topic);
  }
  // Nobody is listening, so the next joiner must not be handed an answer from
  // however long ago the last one left.
  latest.clear();
}

/**
 * Attach a client. Returns the detach function; the caller owns calling it,
 * once, when its connection closes.
 */
export function subscribe(send: Send): () => void {
  clients.add(send);
  // Whatever is already known goes out now, so a screen paints from the stream
  // rather than waiting a full interval or fetching the same thing itself.
  for (const [topic, json] of latest) send(topic, json);
  startTimers();

  let detached = false;
  return () => {
    if (detached) return;
    detached = true;
    clients.delete(send);
    if (clients.size === 0) stopTimers();
  };
}

export function setEventLogger(logger: Logger): void {
  log = logger;
}

/** Test seam: the watcher is module state, and a test file is one process. */
export function resetEvents(): void {
  clients.clear();
  stopTimers();
}

export function clientCount(): number {
  return clients.size;
}
