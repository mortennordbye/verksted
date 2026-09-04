import type { FeedSource } from "../../../shared/api";

/**
 * Which source a row came from, as a shape.
 *
 * The word was already there — `mail`, `github` — in 11px grey at the end of a
 * chip row, which is a place the eye arrives at rather than lands on. Down a
 * list of twenty, a mail and a pull request were the same silhouette and the
 * only way to tell them apart was to read.
 *
 * Shape rather than colour, deliberately. theme.css spends real argument on
 * the fact that every hue here already means something: the state trio says
 * how a thing is doing, the three agent brands say which CLI, the six council
 * colours say who is speaking. A seventh set keyed to "which source" would
 * collide with all of them, and eleven near-greys would tell you nothing
 * anyway. Eleven distinct outlines at 15px are read at a glance and stay
 * legible for whoever cannot separate the hues.
 *
 * Drawn at 24 with the same stroke weight and caps as the tab bar's icons, so
 * these are the same set rather than a second one.
 */
const PATHS: Record<FeedSource, React.ReactNode> = {
  mail: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
    </>
  ),
  // A pull request rather than the Octocat: this is a stroke set, and the
  // silhouette people actually associate with a repository's traffic.
  github: (
    <>
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6M18 9v3a3 3 0 0 1-3 3H9" />
    </>
  ),
  schedule: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 11h18" />
    </>
  ),
  bench: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m7 10 2.5 2.5L7 15M13 15h4" />
    </>
  ),
  memory: (
    <>
      <path d="M12 3a6 6 0 0 0-3.5 10.9V17h7v-3.1A6 6 0 0 0 12 3Z" />
      <path d="M9.5 20h5" />
    </>
  ),
  docs: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
    </>
  ),
  finance: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M15 9.5A2.5 2.5 0 0 0 12.5 8h-1a2.5 2.5 0 0 0 0 5h1a2.5 2.5 0 0 1 0 5h-1A2.5 2.5 0 0 1 9 14.5M12 6.5v11" />
    </>
  ),
  paper: (
    <>
      <path d="M4 5h16v14H4z" />
      <path d="M7 9h6M7 13h10M7 16h7" />
    </>
  ),
  // Something you sent in from the share sheet: an inbox tray.
  intake: (
    <>
      <path d="M3 13h5l2 3h4l2-3h5" />
      <path d="M5 5h14l2 8v6H3v-6Z" />
    </>
  ),
  // A card the assistant is asking you to tap.
  proposal: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
};

export default function SourceMark({
  source,
  className = "",
}: {
  source: FeedSource;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      // The word is gone from the row, so the shape has to carry the name for
      // anyone reading it aloud rather than looking at it.
      role="img"
      aria-label={source}
      className={`flex-none ${className}`}
    >
      {PATHS[source]}
    </svg>
  );
}
