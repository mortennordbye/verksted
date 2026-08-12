import { useEffect, useMemo, useState } from "react";
import type { ReviewVerdict, SessionPatch, SessionReview } from "../../../shared/api";
import { api } from "../api";
import { diffLineClass, splitPatch } from "../diff";
import { useOverlayDismiss } from "../useDismissOnBack";

/** Files start open until this many lines are already on screen; the rest wait
 *  to be asked for, so a big night does not cost a phone thousands of nodes. */
const OPEN_BUDGET = 3_000;

/**
 * A run read end to end.
 *
 * The changes tab answers "what moved" a file at a time, which is the wrong
 * unit for judging a night's work: the question is whether the whole thing is
 * right, and answering it meant a round trip and a lost place in the list per
 * file. This is the same range as one patch, in one scroll, with each file
 * tickable as it is read — and the ticks live on the session, so a review
 * started on a phone is still half-done when it is opened on a laptop.
 */
export default function ReviewOverlay({
  sessionId,
  label,
  review,
  onReview,
  onClose,
}: {
  sessionId: string;
  /** What is being reviewed, for the header: the session's own name. */
  label: string;
  review: SessionReview;
  onReview: (next: SessionReview) => void;
  onClose: () => void;
}) {
  useOverlayDismiss(true, onClose);

  const [patch, setPatch] = useState<SessionPatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let live = true;
    api<SessionPatch>(`/api/sessions/${sessionId}/changes/patch`)
      .then((p) => live && setPatch(p))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [sessionId]);

  const files = useMemo(() => (patch ? splitPatch(patch.diff) : []), [patch]);
  const read = useMemo(() => new Set(review.files), [review.files]);

  // Fixed once, from the patch alone: a file collapsing the moment it is ticked
  // would move everything below it out from under the reader's thumb.
  const openByDefault = useMemo(() => {
    const out: Record<string, boolean> = {};
    let budget = OPEN_BUDGET;
    for (const f of files) {
      out[f.path] = budget > 0;
      budget -= f.lines.length;
    }
    return out;
  }, [files]);

  const isOpen = (path: string) => open[path] ?? openByDefault[path] ?? false;

  /**
   * Nothing is disabled while this is in flight, and the tick only moves when
   * the server has it. Ticking four files in a row is the ordinary case, and
   * the writes are serialised there (see sessions-store) rather than prevented
   * here — a checkbox that goes dead under a thumb for a round trip is the
   * worse half of the trade.
   */
  async function send(body: {
    file?: { path: string; read: boolean };
    verdict?: ReviewVerdict | null;
  }) {
    try {
      onReview(
        await api<SessionReview>(`/api/sessions/${sessionId}/review`, {
          method: "PATCH",
          body: JSON.stringify(body),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const done = files.filter((f) => read.has(f.path)).length;

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-2 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`review ${label}`}
        className="flex h-full w-full max-w-[980px] flex-col overflow-hidden rounded-xl border border-line bg-surface sm:h-[90vh]"
      >
        <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-3.5 py-2.5 font-mono text-[12px]">
          <span className="min-w-0 truncate text-muted">review · {label}</span>
          {files.length > 0 && (
            <span className="text-faint">
              {done} of {files.length} read
            </span>
          )}
          <div className="ml-auto flex items-center gap-1.5">
            <VerdictButton
              active={review.verdict === "approved"}
              onClick={() => send({ verdict: review.verdict === "approved" ? null : "approved" })}
              className="text-run"
            >
              ✓ approved
            </VerdictButton>
            <VerdictButton
              active={review.verdict === "needs-work"}
              onClick={() =>
                send({ verdict: review.verdict === "needs-work" ? null : "needs-work" })
              }
              className="text-wait"
            >
              ⚠ needs work
            </VerdictButton>
            <button
              onClick={onClose}
              aria-label="close"
              className="px-2 text-faint hover:text-text"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto font-mono text-[12.5px]">
          {!patch && !error && <div className="p-4 text-faint">…</div>}
          {error && <div className="p-4 text-wait">{error}</div>}
          {patch && files.length === 0 && (
            <div className="p-4 text-faint">
              nothing committed in this range — the git tab has the working tree
            </div>
          )}

          {files.map((f) => (
            <section key={f.path} className="border-b border-line last:border-b-0">
              {/* Sticky so the path stays readable while its own diff scrolls
                  past, which on a phone is most of the time. */}
              <div className="sticky top-0 z-10 flex items-center gap-2 bg-surface-2 px-3 py-1.5">
                <button
                  onClick={() => setOpen({ ...open, [f.path]: !isOpen(f.path) })}
                  aria-expanded={isOpen(f.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <span className="flex-none text-faint">{isOpen(f.path) ? "▾" : "▸"}</span>
                  <span className="min-w-0 truncate text-text" title={f.path}>
                    {f.path}
                  </span>
                  {!isOpen(f.path) && (
                    <span className="flex-none text-[11px] text-faint">{f.lines.length} lines</span>
                  )}
                </button>
                <label className="flex flex-none cursor-pointer items-center gap-1.5 text-[11px] text-faint hover:text-text">
                  <input
                    type="checkbox"
                    checked={read.has(f.path)}
                    onChange={(e) => send({ file: { path: f.path, read: e.target.checked } })}
                    className="accent-accent"
                  />
                  read
                </label>
              </div>
              {isOpen(f.path) && (
                <pre className="overflow-x-auto px-3 py-2 leading-relaxed">
                  {f.lines.map((line, i) => (
                    <div key={i} className={diffLineClass(line)}>
                      {line || " "}
                    </div>
                  ))}
                </pre>
              )}
            </section>
          ))}

          {patch?.truncated && (
            <div className="px-3 py-3 text-[11px] text-wait">
              …a long range, cut at a file boundary — the rest is in the terminal
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function VerdictButton({
  active,
  onClick,
  className,
  children,
}: {
  active: boolean;
  onClick: () => void;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`cursor-pointer rounded-md border px-2 py-1 text-[11px] ${
        active ? `border-current ${className}` : "border-line text-faint hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
