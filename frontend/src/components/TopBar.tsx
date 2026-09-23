import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { openPalette } from "../palette";
import { Badge, isTabRoute, TabLinks, useNeedsYou } from "./Tabs";
import Icon from "./Icon";

/**
 * The way up, as a pop rather than a push: pushing meant the browser's own Back
 * then went forward into the screen you had just left. `to` is where a tab
 * opened straight onto this screen goes instead.
 *
 * Exported because the phone session screen carries it without the bar around
 * it, and this rule is worth having in one place.
 */
export function BackButton({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button
      onClick={() => (history.length > 1 ? navigate(-1) : navigate(to))}
      aria-label="back"
      className="tap-sq flex-none rounded-[7px] border border-line bg-surface px-2.5 py-1.5 text-muted hover:border-faint hover:text-text"
    >
      <Icon name="back" size={14} />
    </button>
  );
}

/**
 * The two bar icons were the text glyphs "✉" and "⚙". No mono font ships
 * either, so both came from whatever fallback the platform picked: they landed
 * at different weights and sizes next to each other, and on iOS — the device
 * this bar is mostly read on — U+2709 has an emoji presentation, so the inbox
 * button rendered as a colour emoji. Drawing them makes both deterministic.
 */
function IconLink({
  to,
  title,
  label,
  badge,
  children,
}: {
  to: string;
  title: string;
  /**
   * A word beside the icon on a wide screen, drawn like the four screens'
   * links so the bar reads as one row rather than words and a boxed button.
   */
  label?: string;
  /** A count worth interrupting for; nothing is drawn at zero. */
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      title={badge ? `${title} · ${badge} waiting` : title}
      aria-label={badge ? `${title}, ${badge} waiting` : title}
      className={({ isActive }) =>
        `tap-sq relative flex flex-none items-center gap-1.5 text-[14.5px] font-medium ${
          isActive ? "text-text" : "text-faint hover:text-text"
        }`
      }
    >
      <svg
        viewBox="0 0 24 24"
        width="17"
        height="17"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="flex-none"
      >
        {children}
      </svg>
      {label && <span className="hidden min-[1000px]:inline">{label}</span>}
      <Badge count={badge ?? 0} />
    </NavLink>
  );
}

/** One step of the trail. `to` makes it a link; the step you are on has none. */
export interface Crumb {
  label: string;
  to?: string;
}

/** A step of the trail, as a link when there is somewhere above it to go. */
function CrumbLabel({ crumb, first }: { crumb: Crumb; first: boolean }) {
  const className = `overflow-hidden text-ellipsis whitespace-nowrap ${
    first
      ? "text-[16.5px] font-semibold tracking-[-.02em] text-text"
      : "text-[14px] font-normal text-muted"
  }`;
  if (!crumb.to) return <b className={className}>{crumb.label}</b>;
  return (
    <Link to={crumb.to} className={`${className} hover:text-accent`}>
      <b>{crumb.label}</b>
    </Link>
  );
}

export default function TopBar({
  crumb,
  back,
  className = "",
}: {
  crumb?: Crumb[];
  back?: string;
  /** Extra classes on the header itself. A wrapper would break its sticky. */
  className?: string;
}) {
  // What the inbox's headline counts, so the badge and the page agree.
  const needs = useNeedsYou();
  // One rule for the whole app, read off the route rather than passed in by
  // each screen. On a wide screen every bar is the same: the four doors as
  // words and settings, whatever screen you are on. On a phone, where there is
  // no room for words, the four doors are the bottom bar, and a screen you
  // drilled into carries a back arrow and the envelope instead. Screens used to
  // decide this for themselves and drifted — the inbox kept a trail and lost
  // the nav, and settings wore an arrow and an envelope Today did not.
  const onTab = isTabRoute(useLocation().pathname);
  return (
    // A tone of its own, a firmer rule and a shadow falling onto the page: on
    // the page's own ground with a hairline, the bar and whatever scrolled
    // under it read as one surface.
    <header
      className={`sticky top-0 z-20 flex flex-none transform-gpu items-center gap-3 border-b border-line-strong bg-surface/95 px-[18px] py-2.5 pt-[max(10px,env(safe-area-inset-top),var(--banner-h,0px))] shadow-[0_6px_20px_var(--color-shadow)] backdrop-blur-md min-[800px]:py-3.5 min-[800px]:pt-[max(14px,env(safe-area-inset-top),var(--banner-h,0px))] ${className}`}
    >
      {/* A phone's way up, where the bar has no room for the screens. On a wide
          screen every screen carries the same row of doors and the trail's own
          links, so an arrow there was the one thing that made settings or a
          session look like a different bar. */}
      {back !== undefined && !onTab && (
        <span className="flex-none min-[800px]:hidden">
          <BackButton to={back} />
        </span>
      )}
      {/* The mark is a dot with a halo, carried over from the northlight header,
          rather than the mono lockup and blinking block it replaces — that read
          as a CLI that happens to have a web page. The dot is the accent, so it
          follows a palette swap without being touched.

          The wordmark stays on the sub-screens too. It was dropped there once,
          on the grounds that the app's own name is the one thing you already
          know — but that left a 9px dot as the only way to the hub, which is
          not a thing anyone discovers. The name is the way home, spelled out,
          and the trail after it is what says where you are. */}
      <Link
        to="/"
        aria-label="verksted — home"
        // `tap`, not `tap-sq`: the word carries its own width, and this needs
        // to be a 44px-high target on a phone rather than a 9px dot.
        className="tap flex flex-none items-center gap-2 text-[18px] font-bold tracking-[-0.03em] hover:text-accent"
      >
        <span className="relative h-[9px] w-[9px] flex-none rounded-full bg-accent">
          <span className="absolute -inset-[5px] rounded-full bg-accent/15" />
        </span>
        verksted
      </Link>
      {crumb && crumb.length > 0 && (
        // Only the last one survives a phone, and it is the one that says which
        // thing you are looking at — on the session screen the only place the
        // title shows at all, since that screen drops its own title row to give
        // the terminal the height back.
        //
        // It used to keep the first as well. That was before the wordmark came
        // back to its left: three names plus two buttons in 390px truncated the
        // lot to "ver… / Im…", which answers neither question. The step above
        // is what the back button is for on a phone; on a wide screen there is
        // room to spell the whole trail out and every step of it is a link.
        <div className="flex min-w-0 items-center gap-2">
          {crumb.map((c, i) => (
            <span
              key={c.label}
              className={`${
                i === crumb.length - 1 ? "flex" : "hidden min-[800px]:flex"
              } min-w-0 items-center gap-2`}
            >
              <span className="flex-none text-faint">/</span>
              <CrumbLabel crumb={c} first={i === 0} />
            </span>
          ))}
        </div>
      )}
      <div className="ml-auto flex flex-none items-center gap-5">
        {/* The four screens, as words, on every screen wide enough for words:
            the bar on settings or a session is the same bar as on Today. */}
        <TabLinks badge={needs} />
        {/* The envelope is the phone's way to the inbox from a screen with no
            bottom bar. On a wide screen the word Inbox is right beside it, so
            there it would be a second door to the same place. */}
        {!onTab && (
          <span className="flex-none min-[800px]:hidden">
            <IconLink to="/runs" title="inbox — what the schedules did" badge={needs}>
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </IconLink>
          </span>
        )}
        {/* The palette's door. Cmd/Ctrl+K was the only one, which a phone
            does not have, and nothing on a desk said it was there. */}
        <button
          onClick={openPalette}
          title="search projects, sessions, the inbox and documents (⌘K)"
          aria-label="search…"
          className="tap-sq flex flex-none items-center text-faint hover:text-text"
        >
          <Icon name="search" size={17} />
        </button>
        <IconLink to="/settings" title="settings" label="Settings">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </IconLink>
      </div>
    </header>
  );
}
