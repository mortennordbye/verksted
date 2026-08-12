import type { Session } from "../../shared/api";

/**
 * The push half of usePoll: one EventSource for the whole app, feeding the two
 * answers every screen wants.
 *
 * Screens do not talk to this directly. usePoll checks whether a path is one
 * the stream serves and, if it is, takes its data from here instead of a timer
 * — so the call sites read the same as they always did and the polling is gone
 * from underneath them.
 *
 * Everything here is deliberately a fallback rather than a replacement: if the
 * stream never connects, or connects and goes quiet (a proxy that buffers event
 * streams is the classic way to lose one), `healthy` stays false and usePoll
 * keeps its original interval. The push is an optimisation; the poll is the
 * contract.
 */

type Topic = "sessions" | "projects";

const TOPICS: Topic[] = ["sessions", "projects"];

/** A stream that connects but says nothing this long is not working. */
const SILENCE_MS = 8_000;

const latest = new Map<Topic, unknown>();
const listeners = new Set<() => void>();
let source: EventSource | null = null;
let healthy = false;
let silence: ReturnType<typeof setTimeout> | undefined;

function announce(): void {
  for (const cb of listeners) cb();
}

function setHealthy(next: boolean): void {
  if (healthy === next) return;
  healthy = next;
  announce();
}

function open(): void {
  if (source || typeof EventSource === "undefined") return;
  source = new EventSource("/api/events");
  for (const topic of TOPICS) {
    source.addEventListener(topic, (e) => {
      try {
        latest.set(topic, JSON.parse((e as MessageEvent<string>).data));
      } catch {
        return; // not something this app sent
      }
      setHealthy(true);
      announce();
    });
  }
  // EventSource reconnects itself; this only records that right now it is not
  // delivering, which is what puts usePoll back on its own timer meanwhile.
  source.addEventListener("error", () => setHealthy(false));
  clearTimeout(silence);
  silence = setTimeout(() => setHealthy(false), SILENCE_MS);
}

function close(): void {
  source?.close();
  source = null;
  clearTimeout(silence);
  setHealthy(false);
  // The next open is answered with a fresh snapshot, and holding the old one
  // would let a screen paint from state that predates however long the page
  // spent in a pocket.
  latest.clear();
}

if (typeof document !== "undefined") {
  // A backgrounded tab holding the stream open keeps the pod computing for
  // nobody — the whole point of moving this off timers. What matters while the
  // phone is away is the push notification, which does not come through here.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) close();
    else if (listeners.size > 0) open();
  });
}

/** Which streamed answer covers a GET path, if any. */
export function streamTopic(path: string): Topic | null {
  if (path === "/api/sessions") return "sessions";
  if (path === "/api/projects") return "projects";
  // One session by id, answered out of the list rather than by its own request.
  // Anything with a further segment (/changes, /chat) is a different question.
  if (/^\/api\/sessions\/[^/?]+$/.test(path)) return "sessions";
  return null;
}

/**
 * What the stream currently holds for a path.
 *
 * Undefined means it has not said yet — keep whatever is on screen. A wrapped
 * null means it has said, and there is no such session: a 404 by another name.
 */
export function streamValue<T>(path: string): { value: T | null } | undefined {
  const topic = streamTopic(path);
  if (!topic) return undefined;
  const snapshot = latest.get(topic);
  if (snapshot === undefined) return undefined;
  if (path === "/api/sessions" || path === "/api/projects") return { value: snapshot as T };

  let id = path.slice("/api/sessions/".length);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A malformed escape is not an id any session has.
  }
  const found = (snapshot as Session[]).find((s) => s.id === id) ?? null;
  return { value: found as T | null };
}

/** True once the stream has delivered something and has not failed since. */
export function streamHealthy(): boolean {
  return healthy;
}

/** Listen for new data or a change in health. Returns the unsubscribe. */
export function subscribeStream(cb: () => void): () => void {
  listeners.add(cb);
  if (!document.hidden) open();
  return () => {
    listeners.delete(cb);
    // The connection outlives any one screen on purpose: navigating between
    // hub and session would otherwise drop and rebuild it every time.
  };
}

/** Test seam: module state, and a test file is one page. */
export function resetStream(): void {
  listeners.clear();
  close();
}
