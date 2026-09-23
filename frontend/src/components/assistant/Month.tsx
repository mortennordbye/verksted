import { useEffect, useState } from "react";
import type { CalendarEvent } from "../../../../shared/api";
import { api } from "../../api";
import { SkeletonList } from "../Skeleton";
import { dockBtn } from "./Dock";

/** Local midnight of a date: the grid's days are the bench's days. */
function midnight(d: Date, plusDays = 0): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + plusDays);
}

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * The calendar as a month, so what the chair just added, moved or removed can
 * be seen landing. Read again whenever the thread grows, since that is the
 * moment it may have changed.
 */
export default function Month({ refresh }: { refresh: number }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [picked, setPicked] = useState(() => midnight(new Date()).getTime());
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Monday first, always six rows: every month fits, and the grid keeps its
  // height from one month to the next.
  const first = midnight(month, -((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => midnight(first, i));
  const from = first.toISOString();
  const to = midnight(first, 42).toISOString();

  useEffect(() => {
    let live = true;
    api<CalendarEvent[]>(
      `/api/calendar/range?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`,
    )
      .then((e) => {
        if (!live) return;
        setEvents(e);
        setError(null);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [from, to, refresh]);

  /** Everything that touches a day, so an all-day or overnight event shows on each. */
  const on = (day: Date) => {
    const start = day.getTime();
    const end = midnight(day, 1).getTime();
    return (events ?? []).filter((e) => Date.parse(e.start) < end && Date.parse(e.end) > start);
  };
  const today = midnight(new Date()).getTime();
  const pickedDay = new Date(picked);
  const pickedEvents = on(pickedDay);
  const go = (months: number) =>
    setMonth((m) => new Date(m.getFullYear(), m.getMonth() + months, 1));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      <div className="mb-2.5 flex items-center gap-1.5">
        <span className="text-[15px] font-semibold capitalize">
          {month.toLocaleDateString([], { month: "long", year: "numeric" })}
        </span>
        <span className="flex-1" />
        <button onClick={() => go(-1)} aria-label="previous month" className={dockBtn}>
          ‹
        </button>
        <button
          onClick={() => {
            const now = new Date();
            setMonth(new Date(now.getFullYear(), now.getMonth(), 1));
            setPicked(midnight(now).getTime());
          }}
          className={dockBtn}
        >
          today
        </button>
        <button onClick={() => go(1)} aria-label="next month" className={dockBtn}>
          ›
        </button>
      </div>
      {error && <div className="mb-2 text-[12.5px] text-fail">{error}</div>}

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-xl bg-line ring-1 ring-line">
        {days.slice(0, 7).map((d) => (
          <div
            key={`h${d.getDay()}`}
            className="bg-surface py-1 text-center font-mono text-[10.5px] text-faint"
          >
            {d.toLocaleDateString([], { weekday: "short" })}
          </div>
        ))}
        {days.map((d) => {
          const list = on(d);
          const key = d.getTime();
          return (
            <button
              key={key}
              type="button"
              onClick={() => setPicked(key)}
              aria-pressed={key === picked}
              className={`flex min-h-[4.75rem] min-w-0 flex-col items-stretch gap-0.5 p-1 text-left hover:bg-surface-2 ${
                key === picked ? "bg-surface-2 ring-2 ring-accent ring-inset" : "bg-surface"
              } ${d.getMonth() === month.getMonth() ? "" : "opacity-45"}`}
            >
              <span
                className={`self-start rounded-full px-1.5 font-mono text-[11px] ${
                  key === today ? "bg-accent text-on-accent" : "text-muted"
                }`}
              >
                {d.getDate()}
              </span>
              {list.slice(0, 3).map((e) => (
                <span
                  key={`${e.uid}-${e.start}`}
                  className="truncate rounded bg-accent-tint px-1 text-[10.5px] leading-[1.45]"
                >
                  {!e.allDay && <span className="text-muted">{clock(e.start)} </span>}
                  {e.summary}
                </span>
              ))}
              {list.length > 3 && (
                <span className="px-1 text-[10px] text-faint">+{list.length - 3} more</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex flex-col gap-1.5">
        <div className="font-mono text-[11px] text-faint capitalize">
          {pickedDay.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}
        </div>
        {events === null && !error && (
          <SkeletonList
            count={2}
            gap="gap-1.5"
            className="h-[42px] rounded-lg border border-line bg-surface"
          />
        )}
        {events !== null && pickedEvents.length === 0 && (
          <div className="text-[13px] text-faint">nothing on the calendar</div>
        )}
        {pickedEvents.map((e) => (
          <div
            key={`${e.uid}-${e.start}`}
            className="flex flex-col gap-0.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px]"
          >
            <div className="flex items-center gap-3">
              <span className="w-[5.5rem] flex-none font-mono text-[12px] text-muted">
                {e.allDay ? "all day" : `${clock(e.start)}–${clock(e.end)}`}
              </span>
              <span className="min-w-0 flex-1 truncate">{e.summary}</span>
              {e.url && (
                <a
                  href={e.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-none text-[11.5px] text-accent hover:underline"
                >
                  open ↗
                </a>
              )}
            </div>
            {e.location && (
              <span className="truncate pl-[6.25rem] text-[12px] text-faint">{e.location}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
