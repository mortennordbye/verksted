import { useCallback, useEffect, useState } from "react";

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "content-type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** Poll a GET endpoint. Pass null to pause (e.g. while a param is unknown). */
export function usePoll<T>(path: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!path) return;
    api<T>(path)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [path]);

  useEffect(() => {
    setData(null);
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, ms);
    return () => clearInterval(id);
  }, [refresh, ms]);

  return { data, error, refresh };
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
