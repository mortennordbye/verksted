import { useCallback, useEffect, useRef, useState } from "react";
import { reportReachable, reportUnreachable } from "./connection";
import { streamHealthy, streamTopic, streamValue, subscribeStream } from "./events";

/** The backend answered, and said no. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Nothing answered: the pod is gone, or the tunnel is down. */
export class OfflineError extends Error {
  constructor() {
    super("can't reach the pod");
  }
}

// Over a dropped WireGuard tunnel a fetch hangs until the browser gives up
// minutes later, and until then the screen sits on stale data looking healthy.
const TIMEOUT_MS = 15_000;

export async function api<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? TIMEOUT_MS),
      headers: {
        // Merged, not replaced: callers pass their own content-type for raw
        // uploads and If-Match when saving.
        ...(init?.body && !(init.headers as Record<string, string>)?.["content-type"]
          ? { "content-type": "application/json" }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    reportUnreachable();
    throw new OfflineError();
  }
  reportReachable();
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** How often a streamed path is still fetched anyway. Cover for a stream that
 *  connects, reports itself healthy and then quietly stops delivering. */
const BACKSTOP_MS = 60_000;

/**
 * Poll a GET endpoint. Pass null to pause (e.g. while a param is unknown).
 *
 * `loading` exists because `data === null` used to mean three different things
 * at once — still loading, genuinely empty, and failed — so the hub flashed "no
 * projects" on every load and an unknown session id sat on "…" forever.
 *
 * Some paths are pushed rather than polled (see events.ts): those take their
 * data from the stream, drop to a slow backstop interval, and fall straight
 * back to polling at the requested rate the moment the stream stops looking
 * healthy. Call sites do not choose — a path is streamed or it is not.
 */
export function usePoll<T>(path: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [notFound, setNotFound] = useState(false);
  const streamed = path !== null && streamTopic(path) !== null;
  const [streamOk, setStreamOk] = useState(streamHealthy);
  /**
   * Which answer is the current one. Bumped by every request and by every push,
   * so a reply that arrives after something newer is dropped rather than
   * applied — over a tunnel a slow fetch really can land after the push that
   * superseded it, and the screen would then go backwards.
   */
  const generation = useRef(0);

  const refresh = useCallback(() => {
    if (!path) return;
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    api<T>(path)
      .then((d) => {
        if (!current()) return;
        setData(d);
        setError(null);
        setNotFound(false);
      })
      .catch((e: Error) => {
        if (!current()) return;
        setError(e.message);
        // A 404 is an answer, not a failure to reach anything: it means this
        // project or session does not exist, and the screen should say so
        // rather than poll a dead path forever.
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      })
      .finally(() => current() && setLoading(false));
  }, [path]);

  // What the path is worth: reset on a change of path, then take the first
  // answer from whichever of the two can give it. Deliberately not keyed on
  // stream health — a stream dropping must not blank the screen.
  useEffect(() => {
    setData(null);
    setNotFound(false);
    setLoading(path !== null);
    if (path === null) return;

    const fromStream = (): boolean => {
      const hit = streamValue<T>(path);
      if (!hit) return false;
      // Newer than anything in flight, by definition: the server sent it.
      generation.current++;
      setData(hit.value);
      setNotFound(hit.value === null);
      setError(null);
      setLoading(false);
      return true;
    };

    // Navigating back to a screen the stream already covers paints from what it
    // last sent, with no request at all.
    if (!streamed || !fromStream()) refresh();
    if (!streamed) return;

    return subscribeStream(() => {
      setStreamOk(streamHealthy());
      fromStream();
    });
  }, [refresh, path, streamed]);

  // The timer, at the requested rate or as a slow backstop behind the stream.
  useEffect(() => {
    if (path === null) return;
    const every = streamed && streamOk ? Math.max(ms, BACKSTOP_MS) : ms;
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, every);
    // Coming back to a backgrounded tab or a pocketed phone otherwise shows up
    // to a full interval of stale data before the next tick.
    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, ms, path, streamed, streamOk]);

  return { data, error, loading, notFound, refresh };
}

/** Elapsed time as a duration: "just now", "5 min", "2 h", "3 d". */
export function durLabel(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / (24 * 60))} d`;
}

/** Elapsed time as a point in the past: "just now", "5 min ago". */
export function agoLabel(iso: string | null): string {
  const d = durLabel(iso);
  return d === "just now" || d === "never" ? d : `${d} ago`;
}
