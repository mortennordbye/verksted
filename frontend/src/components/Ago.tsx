import { useSyncExternalStore } from "react";
import { agoLabel } from "../api";

/**
 * One clock for every timestamp on screen. "3m ago" drawn once is wrong a
 * minute later, and the bubbles it sits in are memoised, so they never asked
 * again: a reply read an hour on still said "just now".
 */
const listeners = new Set<() => void>();
let minute = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  timer ??= setInterval(() => {
    minute++;
    for (const l of listeners) l();
  }, 60_000);
  return () => {
    listeners.delete(fn);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** When something was said: relative, kept current, with the clock time behind it. */
export default function Ago({ at, className }: { at: string; className?: string }) {
  useSyncExternalStore(subscribe, () => minute);
  const when = new Date(at);
  return (
    <time
      dateTime={at}
      title={when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
      className={className}
    >
      {agoLabel(at)}
    </time>
  );
}

/** The day something was said, as a separator names it. */
export function dayLabel(at: string, now = new Date()): string {
  const d = new Date(at);
  const days = Math.round(
    (new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() -
      new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) /
      86_400_000,
  );
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

/** Drawn above the first thing said on a new day. */
export function DayRule({ at }: { at: string }) {
  return (
    <div role="separator" className="caps my-1 text-center text-[10.5px] text-faint">
      {dayLabel(at)}
    </div>
  );
}

/** Whether two moments fall on different local days. */
export function newDay(prev: string | undefined, at: string): boolean {
  return prev === undefined || new Date(prev).toDateString() !== new Date(at).toDateString();
}
