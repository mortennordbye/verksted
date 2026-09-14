import { useState } from "react";
import Markdown from "react-markdown";
import type { FeedItem, ProposalAction } from "../../../shared/api";
import { api } from "../api";
import { cite, citeUrl } from "./chat/cite";
import { MD, REMARK } from "./chat/markdown";

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

  const LABELS: Record<ProposalAction["kind"], string> = {
    send: "send",
    calendar_put: "put on the calendar",
    merge_pr: "merge",
    end_session: "end it",
    delete_schedule: "delete it",
    start_session: "start it",
    desk_session: "start it",
  };
  const label = LABELS[a.kind];
  const why = item.detail.includes("\n\n") ? item.detail.split("\n\n")[0] : null;

  return (
    <div className="mt-2 rounded-[11px] border border-accent/40 bg-accent-tint px-3.5 py-3">
      {/* Why they are being asked, in the assistant's own words: prose like the
          rest of its prose, citations included. */}
      {why && (
        <div className="mb-2 text-[12.5px] text-muted">
          <Markdown components={MD} remarkPlugins={REMARK} urlTransform={citeUrl}>
            {cite(why)}
          </Markdown>
        </div>
      )}
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
      {/* The prompt is the whole of what the agent will be told, so it is shown
          whole: this card is the one place a session started off something the
          assistant read can be seen before it runs. */}
      {a.kind === "start_session" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="font-mono text-[12.5px]">
            {a.agent} in {a.project}
            {a.title ? ` — ${a.title}` : ""}
          </div>
          {a.prompt && (
            <div className="mt-1.5 text-[12.5px] whitespace-pre-wrap text-muted">{a.prompt}</div>
          )}
        </div>
      )}
      {a.kind === "desk_session" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="font-medium">{a.title}</div>
          <div className="mt-1 text-[12.5px] whitespace-pre-wrap text-muted">{a.ask}</div>
        </div>
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
