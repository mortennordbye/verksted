import { useCallback, useEffect, useState } from "react";
import { reportReachable, reportUnreachable } from "./connection";

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

/**
 * Poll a GET endpoint. Pass null to pause (e.g. while a param is unknown).
 *
 * `loading` exists because `data === null` used to mean three different things
 * at once — still loading, genuinely empty, and failed — so the hub flashed "no
 * projects" on every load and an unknown session id sat on "…" forever.
 */
export function usePoll<T>(path: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [notFound, setNotFound] = useState(false);

  const refresh = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
        setNotFound(false);
      })
      .catch((e: Error) => {
        setError(e.message);
        // A 404 is an answer, not a failure to reach anything: it means this
        // project or session does not exist, and the screen should say so
        // rather than poll a dead path forever.
        if (e instanceof ApiError && e.status === 404) setNotFound(true);
      })
      .finally(() => setLoading(false));
  }, [path]);

  useEffect(() => {
    setData(null);
    setNotFound(false);
    setLoading(path !== null);
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, ms);
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
  }, [refresh, ms, path]);

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
