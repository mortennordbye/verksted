import { Link, useNavigate } from "react-router";
import type { Memory } from "../../../shared/api";
import { usePoll } from "../api";

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
  badge,
  children,
}: {
  to: string;
  title: string;
  /** A count worth interrupting for; nothing is drawn at zero. */
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      title={badge ? `${title} · ${badge} waiting` : title}
      aria-label={badge ? `${title}, ${badge} waiting` : title}
      className="tap-sq relative flex flex-none items-center justify-center rounded-[7px] border border-line bg-surface px-2.5 py-1.5 text-muted hover:border-faint hover:text-text"
    >
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
      {badge ? (
        <span className="absolute -top-1 -right-1 min-w-[15px] rounded-full bg-accent px-1 text-center font-mono text-[10px] leading-[15px] font-semibold text-on-accent">
          {badge > 9 ? "9+" : badge}
        </span>
      ) : null}
    </Link>
  );
}

export default function TopBar({ crumb, back }: { crumb?: string[]; back?: string }) {
  const navigate = useNavigate();
  // A harvested memory that nobody notices is a harvest that did not happen:
  // the queue is the one thing in the inbox that arrives without a session or a
  // run to announce it. Polled slowly on purpose — it changes once a night.
  const { data: proposed } = usePoll<{ proposals: Memory[] }>("/api/memory/proposed", 120_000);
  return (
    <header className="sticky top-0 z-20 flex flex-none items-center gap-3 border-b border-line bg-bg/90 px-[18px] py-2.5 pt-[max(10px,env(safe-area-inset-top))] backdrop-blur-md min-[800px]:py-3.5 min-[800px]:pt-[max(14px,env(safe-area-inset-top))]">
      {back !== undefined && (
        <button
          // Pop rather than push: pushing meant the browser's own Back
          // then went forward into the screen you had just left.
          onClick={() => (history.length > 1 ? navigate(-1) : navigate(back))}
          aria-label="back"
          className="flex-none rounded-[7px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
        >
          ←
        </button>
      )}
      <Link
        to="/"
        className="flex flex-none items-center font-mono text-[15px] font-semibold tracking-wide"
      >
        verksted
        <span className="ml-1 inline-block h-4 w-2 animate-blink bg-accent" />
      </Link>
      {crumb && crumb.length > 0 && (
        // A phone gets the last crumb only — it is the sole place the session
        // name shows there, since the session screen drops its own title row to
        // give the terminal the height back.
        <div className="flex min-w-0 items-center gap-1.5 font-mono text-[13px] text-muted">
          {crumb.map((c, i) => (
            <span
              key={c}
              className={`${i < crumb.length - 1 ? "hidden min-[800px]:flex" : "flex"} min-w-0 items-center gap-1.5`}
            >
              <span className="text-faint">/</span>
              <b className="overflow-hidden font-medium text-ellipsis whitespace-nowrap text-text">
                {c}
              </b>
            </span>
          ))}
        </div>
      )}
      <div className="ml-auto flex flex-none items-center gap-3">
        <IconLink
          to="/runs"
          title="inbox — what the schedules did"
          badge={proposed?.proposals.length}
        >
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
        </IconLink>
        <IconLink to="/settings" title="settings">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </IconLink>
      </div>
    </header>
  );
}
