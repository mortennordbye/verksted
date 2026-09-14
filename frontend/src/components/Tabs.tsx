import { NavLink, useLocation } from "react-router";
import type { FeedItem } from "../../../shared/api";
import { usePoll } from "../api";
import Icon, { type IconName } from "./Icon";

/**
 * The four places a phone goes: Today, the inbox, the bench and the thread.
 *
 * A bar along the bottom on a phone, where the thumb is; on a wide screen the
 * same four are text in the top bar and this renders nothing. Drawn on the
 * top-level screens only: a session or a project has a back arrow, and a
 * second set of doors under a terminal is noise.
 */
const TABS: { to: string; label: string; icon: IconName }[] = [
  // "/today", not "/": once Today is acknowledged "/" goes to the bench, and
  // the tab has to open Today whenever it is tapped.
  { to: "/today", label: "Today", icon: "today" },
  { to: "/runs", label: "Inbox", icon: "inbox" },
  { to: "/bench", label: "Bench", icon: "bench" },
  // "Assistant", not "Chat": the screen is a someone you ask, and the top bar
  // and the settings tab already called it that.
  { to: "/ai", label: "Assistant", icon: "chat" },
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
  // "/" is Today too, until it is acknowledged.
  return pathname === "/" || TABS.some((t) => pathname.startsWith(t.to));
}

/** A tab is lit on its own path, and Today also on "/", where it is drawn unacknowledged. */
function lit(to: string, pathname: string, isActive: boolean): boolean {
  return isActive || (to === "/today" && pathname === "/");
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

/**
 * How many inbox items need you: the number the inbox's own headline says.
 * It counted proposed memories, which is why the tab read 9+ over a page that
 * said two things needed you.
 */
export function useNeedsYou(): number {
  const { data } = usePoll<FeedItem[]>("/api/feed", 60_000);
  return (data ?? []).filter((i) => i.state !== "done" && i.urgency === "attention").length;
}

export default function Tabs() {
  // The same count the top bar carries, read the same way: the phone shows the
  // bar's words nowhere, so the bottom tabs are where it has to appear.
  const needs = useNeedsYou();
  const { pathname } = useLocation();
  return (
    // Gone while the keyboard is up: the composer drops onto the keys, and a
    // bar left between them was a band of dead space in the middle of a phone.
    <nav
      aria-label="screens"
      className="fixed inset-x-0 bottom-0 z-20 flex transform-gpu border-t border-line bg-bg/92 pb-[env(safe-area-inset-bottom)] backdrop-blur-md min-[800px]:hidden kbd:hidden"
    >
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            `tap relative flex flex-1 flex-col items-center gap-0.5 py-2 text-[10.5px] font-medium tracking-[.04em] ${
              lit(t.to, pathname, isActive) ? "text-accent" : "text-faint hover:text-text"
            }`
          }
        >
          {/* The badge rides on the icon: on the whole cell its corner was the
              border with the next tab. */}
          <span className="relative">
            <Icon name={t.icon} size={20} strokeWidth={1.8} />
            {t.to === "/runs" && <Badge count={needs} />}
          </span>
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The same four for the top bar on a wide screen: the bottom bar's icons, at
 * the size of the bar's own, with the word beside each so a glance finds the
 * door and a read confirms it.
 */
export function TabLinks({ badge = 0 }: { badge?: number }) {
  const { pathname } = useLocation();
  return (
    <nav aria-label="screens" className="hidden items-center gap-5 min-[800px]:flex">
      {TABS.map((t) => (
        <NavLink
          key={t.to}
          to={t.to}
          className={({ isActive }) =>
            `flex items-center gap-1.5 text-[14.5px] font-medium ${lit(t.to, pathname, isActive) ? "text-text" : "text-faint hover:text-text"}`
          }
        >
          <Icon name={t.icon} size={17} />
          {/* Words from 1000px: between that and 800 the five doors and a long
              trail did not fit, and the last door was cut off the edge. */}
          <span className="hidden min-[1000px]:inline">{t.label}</span>
          {t.to === "/runs" && <Badge count={badge} inline />}
        </NavLink>
      ))}
    </nav>
  );
}
