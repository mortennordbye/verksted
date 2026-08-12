import { useEffect, useState } from "react";
import type { SessionChanges, SessionReview } from "../../../shared/api";
import { usePoll } from "../api";
import { fileIcon } from "../fileicons";
import ReviewOverlay from "./ReviewOverlay";
import { ReviewMark } from "./StatusChip";

/** A range's ends, short enough for a sidebar. */
const short = (sha: string) => (sha === "HEAD" ? "HEAD" : sha.slice(0, 7));

/**
 * What the session committed, beside the terminal that committed it.
 *
 * The inbox says "3 commits · 2 files"; this is the answer to the next
 * question. It reads the session's own range — where the repo was when it
 * started, to where it was when it finished — so an overnight run can be judged
 * from a phone instead of by opening its terminal and running git by hand.
 *
 * Uncommitted work is deliberately absent: that is the working tree, which
 * belongs to the repo rather than to one session, and the git tab beside this
 * one already shows it.
 */
export default function ChangesPanel({
  sessionId,
  live,
  onOpenDiff,
}: {
  sessionId: string;
  live: boolean;
  onOpenDiff: (path: string) => void;
}) {
  // A finished session's range is pinned at both ends and never moves again, so
  // re-reading it costs two git calls to learn nothing. A live one still grows.
  const { data, error, loading } = usePoll<SessionChanges>(
    `/api/sessions/${sessionId}/changes`,
    live ? 20_000 : 60 * 60_000,
  );
  const [reviewing, setReviewing] = useState(false);
  // Held here rather than re-read: the overlay is what changes it, and the poll
  // behind this panel is an hour wide on the sessions worth reviewing.
  const [review, setReview] = useState<SessionReview | null>(null);
  useEffect(() => {
    if (data) setReview((prev) => prev ?? data.review);
  }, [data]);

  const files = data?.files ?? [];
  const read = new Set(review?.files ?? []);
  const readCount = files.filter((f) => read.has(f.path)).length;

  return (
    <section
      aria-label="changes"
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]"
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-2 text-[11px] tracking-widest text-faint uppercase">
        changes
        {data?.from && (
          <span className="ml-auto normal-case tracking-normal">
            {short(data.from)}..{short(data.to ?? "HEAD")}
          </span>
        )}
      </div>
      {review?.verdict && (
        <div className="px-2.5 pb-2 normal-case">
          <ReviewMark review={review} total={files.length} />
        </div>
      )}

      {loading && <div className="px-2.5 text-faint">…</div>}
      {error && <div className="px-2.5 text-wait">{error}</div>}
      {data && data.from === null && (
        <div className="px-2.5 text-faint">
          no range recorded — this session did not start in a git repo
        </div>
      )}
      {data?.from && data.commits.length === 0 && (
        <div className="px-2.5 text-faint">
          nothing committed {live ? "yet" : "— check the git tab for uncommitted work"}
        </div>
      )}

      {(data?.commits.length ?? 0) > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11px] tracking-widest text-faint uppercase">
            commits
            <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-px text-[10px] normal-case tracking-normal text-muted">
              {data!.commits.length}
            </span>
          </div>
          <ul className="px-2.5">
            {data!.commits.map((c) => (
              <li key={c.sha} className="flex gap-2 py-[3px] text-muted">
                <span className="flex-none text-faint">{c.sha}</span>
                <span className="min-w-0 flex-1 truncate text-text" title={c.subject}>
                  {c.subject}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}

      {files.length > 0 && (
        <>
          <div className="flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11px] tracking-widest text-faint uppercase">
            files
            <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-px text-[10px] normal-case tracking-normal text-muted">
              {readCount > 0 ? `${readCount} of ${files.length} read` : files.length}
            </span>
          </div>
          {/* The whole range in one scroll, which is what judging a night's work
              actually takes; the list below is for going straight to one file. */}
          <button
            onClick={() => setReviewing(true)}
            className="mx-2.5 mb-1 flex w-[calc(100%-1.25rem)] cursor-pointer items-center justify-center gap-1.5 rounded-md border border-line py-1.5 text-[11px] text-muted hover:border-accent-pastel hover:text-accent"
          >
            review all {files.length} files →
          </button>
          <ul>
            {files.map((f) => {
              const name = f.path.split("/").at(-1)!;
              const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
              return (
                <li key={f.path} className="flex items-center rounded-md hover:bg-surface-2">
                  <button
                    onClick={() => onOpenDiff(f.path)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-[7px] px-2.5 py-1 text-left whitespace-nowrap"
                  >
                    <img src={fileIcon(name)} alt="" className="h-4 w-4 flex-none" />
                    <span className={read.has(f.path) ? "text-faint" : "text-text"}>{name}</span>
                    {read.has(f.path) && (
                      <span className="flex-none text-[11px] text-run" title="marked read">
                        ✓
                      </span>
                    )}
                    {dir && <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>}
                    <span className="ml-auto flex-none pl-1.5 text-[11px]">
                      {f.binary ? (
                        <span className="text-faint">binary</span>
                      ) : (
                        <>
                          <span className="text-run">+{f.added}</span>{" "}
                          <span className="text-claude">−{f.removed}</span>
                        </>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {data?.truncated && (
        <div className="px-2.5 pt-2 text-[11px] text-faint">
          …a long range, cut short — the rest is in the terminal
        </div>
      )}

      {reviewing && review && (
        <ReviewOverlay
          sessionId={sessionId}
          label={sessionId}
          review={review}
          onReview={setReview}
          onClose={() => setReviewing(false)}
        />
      )}
    </section>
  );
}
