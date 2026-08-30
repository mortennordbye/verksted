import { useState } from "react";
import type { FeedItem } from "../../../shared/api";
import { api } from "../api";

/**
 * A proposal, whole, with the two buttons.
 *
 * The card shows exactly what will happen: the mail as it will go, the event
 * as it will appear, the merge by number. Do executes on the pod; drop leaves
 * it. Nothing here is a summary, because the tap is the authorisation and a
 * person should never authorise a summary.
 */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function ProposalCard({ item, onChange }: { item: FeedItem; onChange: () => void }) {
  const [busy, setBusy] = useState<"do" | "drop" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const a = item.action;
  if (!a) return null;
  const done = item.state === "done";

  async function act(what: "do" | "drop") {
    if (busy) return;
    setBusy(what);
    setError(null);
    try {
      await api(`/api/proposals/${encodeURIComponent(item.id)}/${what}`, {
        method: "POST",
        timeoutMs: 90_000,
      });
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const label =
    a.kind === "send"
      ? "send"
      : a.kind === "calendar_put"
        ? "put on the calendar"
        : a.kind === "merge_pr"
          ? "merge"
          : a.kind === "end_session"
            ? "end it"
            : "delete it";
  const why = item.detail.includes("\n\n") ? item.detail.split("\n\n")[0] : null;

  return (
    <div className="mt-2 rounded-[11px] border border-accent/40 bg-accent-tint px-3.5 py-3">
      {why && <div className="mb-2 text-[12.5px] text-muted">{why}</div>}
      {a.kind === "send" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 font-mono text-[12px]">
          <div className="text-faint">
            to <span className="text-text">{a.to}</span>
          </div>
          <div className="text-faint">
            subject <span className="text-text">{a.subject}</span>
          </div>
          <div className="mt-2 font-sans text-[13px] whitespace-pre-wrap text-text">{a.body}</div>
        </div>
      )}
      {a.kind === "calendar_put" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="font-medium">{a.summary}</div>
          <div className="font-mono text-[12px] text-muted">
            {when(a.start)} to {when(a.end)}
          </div>
          {a.location && <div className="text-[12.5px] text-muted">{a.location}</div>}
          {a.description && (
            <div className="mt-1 text-[12.5px] whitespace-pre-wrap text-muted">{a.description}</div>
          )}
        </div>
      )}
      {a.kind === "merge_pr" && (
        <div className="font-mono text-[12.5px]">
          squash-merge {a.project} #{a.number} and delete its branch
        </div>
      )}
      {a.kind === "end_session" && (
        <div className="font-mono text-[12.5px]">
          end {a.id}; whatever it has not written is gone
        </div>
      )}
      {a.kind === "delete_schedule" && (
        <div className="font-mono text-[12.5px]">delete schedule {a.id} and its run history</div>
      )}
      {error && <div className="mt-2 font-mono text-[12px] text-fail">{error}</div>}
      {!done ? (
        <div className="mt-3 flex items-center gap-2">
          <button
            onClick={() => void act("do")}
            disabled={busy !== null}
            className="tap rounded-[7px] bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {busy === "do" ? "doing…" : label}
          </button>
          <button
            onClick={() => void act("drop")}
            disabled={busy !== null}
            className="tap rounded-[7px] border border-line px-3 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
          >
            drop
          </button>
        </div>
      ) : (
        <div className="mt-2 font-mono text-[11px] text-faint">{item.did}</div>
      )}
    </div>
  );
}
