import type { ReviewSummary } from "../../../shared/api";

/* The state colours are pastels now, so the old /5 wash was invisible against
   #0b0b0e. Radius is northlight's 6px tag rather than a pill, and the label is
   sans: mono on every chip was most of what made the app read as a terminal. */
const styles = {
  run: "text-run border-run/25 bg-run/12",
  wait: "text-wait border-wait/25 bg-wait/12",
  fail: "text-fail border-fail/25 bg-fail/12",
  idle: "text-faint border-line bg-surface-2",
} as const;

export function StatusChip({ kind, label }: { kind: keyof typeof styles; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[12px] font-semibold whitespace-nowrap ${styles[kind]}`}
    >
      {label}
    </span>
  );
}

/**
 * How far a run has been read, and what was concluded — a row's answer to "have
 * I dealt with this one?", which is the question an inbox of overnight runs
 * mostly asks. Renders nothing until somebody has started.
 */
export function ReviewMark({ review, total }: { review: ReviewSummary; total: number }) {
  if (review.reviewed === 0 && !review.verdict) return null;
  const verdict = review.verdict;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] whitespace-nowrap">
      {verdict && (
        <span className={verdict === "approved" ? "text-run" : "text-wait"}>
          {verdict === "approved" ? "✓ approved" : "⚠ needs work"}
        </span>
      )}
      {review.reviewed > 0 && (
        <span className="text-faint">
          {total > 0 ? `${review.reviewed} of ${total} read` : `${review.reviewed} read`}
        </span>
      )}
    </span>
  );
}

export function StatusDot({ running }: { running: boolean }) {
  return (
    <span
      className={`h-2 w-2 flex-none rounded-full ${running ? "animate-pulse-run bg-run" : "bg-idle"}`}
    />
  );
}

/* A letter in a tinted square rather than a bare coloured dot. Three dots cost
   three hues the palette has to spend on nothing else, and at 7px the three
   were told apart by colour alone — which left nothing for anyone who cannot
   use it, and nothing if the palette ever goes monochrome. */
const AGENT_MARK: Record<string, { letter: string; className: string }> = {
  claude: { letter: "C", className: "text-claude bg-claude/15" },
  antigravity: { letter: "A", className: "text-antigravity bg-antigravity/15" },
  codex: { letter: "X", className: "text-codex bg-codex/15" },
};

/** The square on its own, for rows too tight to spell the agent out. */
export function AgentMark({ agent }: { agent: string }) {
  const mark = AGENT_MARK[agent] ?? { letter: "?", className: "text-faint bg-surface-2" };
  return (
    <i
      title={agent}
      className={`flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md font-mono text-[10.5px] font-medium not-italic ${mark.className}`}
    >
      {mark.letter}
    </i>
  );
}

export function AgentTag({ agent }: { agent: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted">
      <AgentMark agent={agent} />
      {agent}
    </span>
  );
}
