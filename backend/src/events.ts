import { listProjects } from "./projects-store.js";
import * as store from "./sessions-store.js";
import type { Logger } from "./logger.js";

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

/**
 * One client's writer. `whole` comes with a frame that only makes sense after
 * the ones before it (a `sessions-changed`): a client that is not reading and
 * has frames held back is given that instead, since keeping only the newest
 * held frame would otherwise lose a change.
 */
type Send = (event: string, json: string, whole?: { event: string; json: string }) => void;

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

const clients = new Set<Send>();
/** Last payload broadcast per topic — both the change test and what a joining
 *  client is handed so it need not fetch the same thing over again. */
const latest = new Map<Topic, string>();
/** Each session as it was last sent, by id: what `sessions-changed` is measured from. */
let sentSessions = new Map<string, string>();

/**
 * What changed in the session list since it was last sent, or null to send it
 * whole.
 *
 * The list is every session of the last ninety days, about 90 KB on the pod,
 * and one session changing used to send all of it to every client. Now a
 * client is sent the whole list once, on joining, and after that only the
 * sessions that differ, the ids that left, and the order.
 */
function sessionDelta(list: unknown): string | null {
  if (!Array.isArray(list)) return null;
  const now = new Map<string, string>();
  for (const s of list as { id: string }[]) now.set(s.id, JSON.stringify(s));
  const had = sentSessions;
  sentSessions = now;
  if (!had.size) return null;
  const upsert = (list as { id: string }[]).filter((s) => had.get(s.id) !== now.get(s.id));
  const remove = [...had.keys()].filter((id) => !now.has(id));
  return JSON.stringify({ upsert, remove, order: [...now.keys()] });
}
const timers = new Map<Topic, NodeJS.Timeout>();
let log: Pick<Logger, "warn"> = { warn: () => {} };

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
    const value = await SOURCES[topic]();
    const json = JSON.stringify(value);
    if (latest.get(topic) !== json) {
      latest.set(topic, json);
      const delta = topic === "sessions" ? sessionDelta(value) : null;
      for (const send of clients) {
        if (delta && delta.length < json.length) {
          send("sessions-changed", delta, { event: topic, json });
        } else send(topic, json);
      }
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
  sentSessions = new Map();
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

export function setEventLogger(logger: Pick<Logger, "warn">): void {
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
