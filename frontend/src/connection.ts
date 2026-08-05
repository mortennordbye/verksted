import { useSyncExternalStore } from "react";

/**
 * Whether the backend is reachable, tracked in one place.
 *
 * Every screen polls, and none of them can tell on its own whether a failure
 * means "this endpoint is unhappy" or "the pod is gone / WireGuard dropped".
 * Without that distinction the app silently freezes on stale data, which is the
 * worst possible failure for something you drive from a phone: the terminal
 * looks fine and the agent appears idle.
 *
 * Only transport failures count. A fetch that throws (refused, DNS, timeout)
 * means nothing answered; any HTTP status — 500 included — means the backend is
 * there and talking.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let online = true;
let failures = 0;

// One dropped request on a phone radio is not an outage; two in a row is worth
// telling the user about.
const FAILURES_BEFORE_OFFLINE = 2;

function emit(): void {
  for (const l of listeners) l();
}

export function reportReachable(): void {
  failures = 0;
  if (!online) {
    online = true;
    emit();
  }
}

export function reportUnreachable(): void {
  failures++;
  if (online && failures >= FAILURES_BEFORE_OFFLINE) {
    online = false;
    emit();
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOnline(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => online,
    () => true,
  );
}
