import { NavLink } from "react-router";
import type { ReactNode } from "react";
import type { Memory } from "../../../shared/api";
import { usePoll } from "../api";

/**
 * The four places a phone goes: Today, the inbox, the bench and the thread.
 *
 * A bar along the bottom on a phone, where the thumb is; on a wide screen the
 * same four are text in the top bar and this renders nothing. Drawn on the
 * top-level screens only: a session or a project has a back arrow, and a
 * second set of doors under a terminal is noise.
 */
const TABS: { to: string; label: string; icon: ReactNode }[] = [
  {
    to: "/",
    label: "Today",
    icon: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </>
    ),
  },
  {
    to: "/runs",
    label: "Inbox",
    icon: (
      <>
        <rect x="2" y="4" width="20" height="16" rx="2" />
        <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
      </>
    ),
  },
  {
    to: "/bench",
    label: "Bench",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M7 20h10M12 16v4" />
      </>
    ),
  },
  {
    to: "/ai",
    label: "Chat",
    icon: <path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z" />,
  },
];

/**
 * Whether a path is one of the four doors.
 *
 * The top bar asks, so that "which screen carries the four as words" is decided
 * in the same place as "which screen carries them as a bottom bar" — they were
 * two different answers before, and the inbox and the thread fell between them:
 * the bar dropped its nav the moment a screen named itself.
 */
export function isTabRoute(pathname: string): boolean {
  return TABS.some((t) => (t.to === "/" ? pathname === "/" : pathname.startsWith(t.to)));
}

/**
 * A count worth interrupting for, in the corner of whatever carries it. Nothing
 * is drawn at zero.
 *
 * Its own component because the phone session screen shows no top bar, so the
 * same pill has to ride on the ⋯ that took the bar's place.
 */
export function Badge({ count, inline = false }: { count: number; inline?: boolean }) {
  if (!count) return null;
  return (
    <span
      className={`min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-[15px] font-semibold text-on-accent ${
        // Over an icon there is nowhere else for it to go, and the corner it
        // covers is empty. Over a word it covers the word: "Inbox" is five
        // letters and the lozenge is two, so the corner it sat in was the top
        // of the b. Beside the word instead, where a row of words has room.
        inline ? "" : "absolute -top-1 -right-1"
      }`}
    >
      {count > 9 ? "9+" : count}
    </span>
  );
}

export default function Tabs() {
  // The same count the top bar carries, read the same way: the phone shows the
  // bar's words nowhere, so the bottom tabs are where it has to appear.
  const { data: proposed } = usePoll<{ proposals: Memory[] }>("/api/memory/proposed", 120_000);
  return (
    <nav
      aria-label="screens"
      className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-md min-[800px]:hidden"
    >
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === "/"}
          className={({ isActive }) =>
            `tap relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium tracking-[.04em] ${
              isActive ? "text-accent" : "text-faint hover:text-text"
            }`
          }
        >
          <svg
            viewBox="0 0 24 24"
            width="20"
            height="20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {t.icon}
          </svg>
          {t.label}
          {t.to === "/runs" && <Badge count={proposed?.proposals.length ?? 0} />}
        </NavLink>
      ))}
    </nav>
  );
}

/** The same four, as words, for the top bar on a wide screen. */
export function TabLinks({ badge = 0 }: { badge?: number }) {
  return (
    <nav aria-label="screens" className="hidden items-center gap-4 min-[800px]:flex">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          end={t.to === "/"}
          className={({ isActive }) =>
            `flex items-center gap-1.5 text-[13px] font-medium ${isActive ? "text-text" : "text-faint hover:text-text"}`
          }
        >
          {t.label}
          {t.to === "/runs" && <Badge count={badge} inline />}
        </NavLink>
      ))}
    </nav>
  );
}
