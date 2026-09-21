import { useState } from "react";
import Markdown from "react-markdown";
import type { FeedItem, ProposalAction } from "../../../shared/api";
import { api } from "../api";
import { cite, citeUrl } from "./chat/cite";
import { MD, REMARK } from "./chat/markdown";
import Button from "./ui/Button";
import Notice from "./ui/Notice";

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

/** A Gmail filter: what it matches, then what it does to a match. */
function RuleBox({
  rule,
  note,
}: {
  rule: {
    from?: string;
    subject?: string;
    query?: string;
    label?: string;
    archive?: boolean;
    markRead?: boolean;
  };
  note: string;
}) {
  const match = [
    rule.from && `from ${rule.from}`,
    rule.subject && `subject ${rule.subject}`,
    rule.query,
  ].filter(Boolean);
  const does = [
    rule.label && `label ${rule.label}`,
    rule.archive && "archive",
    rule.markRead && "mark read",
  ].filter(Boolean);
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
      <div className="font-mono text-[12px]">{match.join(", ")}</div>
      <div>{does.join(", ")}</div>
      <div className="mt-1 text-[12.5px] text-muted">{note}</div>
    </div>
  );
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
    schedule_put: "set it up",
    run_schedule: "run it",
    mail_rule_put: "add the filter",
    mail_rule_delete: "remove it",
    mail_label_delete: "delete it",
    calendar_delete: "take it off",
    mail_move: "move them",
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
        <div className="text-[13px]">
          squash-merge {a.project} #{a.number} and delete its branch
        </div>
      )}
      {a.kind === "end_session" && (
        <div className="text-[13px]">end {a.id}; whatever it has not written is gone</div>
      )}
      {a.kind === "delete_schedule" && (
        <div className="text-[13px]">delete schedule {a.id} and its run history</div>
      )}
      {/* The prompt is the whole of what the agent will be told, so it is shown
          whole: this card is the one place a session started off something the
          assistant read can be seen before it runs. */}
      {a.kind === "start_session" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="text-[13px]">
            {a.agent} in {a.project}
            {a.title ? ` — ${a.title}` : ""}
          </div>
          {a.prompt && (
            <div className="mt-1.5 text-[12.5px] whitespace-pre-wrap text-muted">{a.prompt}</div>
          )}
        </div>
      )}
      {/* The prompt again, for the same reason start_session shows one: a
          session schedule is that session on a timer, and this card is the
          only place it can be read before it starts running on its own. */}
      {a.kind === "schedule_put" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="text-[13px]">
            {a.id ? `change ${a.id}` : `${a.name} in ${a.project}`}
            {a.cron ? ` — ${a.cron}` : ""}
            {a.enabled === false ? " (paused)" : ""}
          </div>
          {a.prompt && (
            <div className="mt-1.5 text-[12.5px] whitespace-pre-wrap text-muted">{a.prompt}</div>
          )}
        </div>
      )}
      {a.kind === "run_schedule" && (
        <div className="text-[13px]">run {a.id} now; it starts a session straight away</div>
      )}
      {/* What the account holds, read by the pod as the card was filed: the
          filter, the event and the subjects are not the assistant's wording. */}
      {(a.kind === "mail_rule_put" || a.kind === "mail_rule_delete") && (
        <RuleBox
          rule={a.kind === "mail_rule_put" ? a : a.rule}
          note={
            a.kind === "mail_rule_put"
              ? "acts on every matching mail from now on, without asking"
              : "its definition goes with it"
          }
        />
      )}
      {a.kind === "mail_label_delete" && (
        <div className="text-[13px]">
          delete the label {a.name}; the mail stays, the label comes off every message and cannot be
          put back
        </div>
      )}
      {a.kind === "calendar_delete" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="font-medium">{a.event.summary}</div>
          <div className="font-mono text-[12px] text-muted">
            {when(a.event.start)} to {when(a.event.end)}
          </div>
          {a.event.location && <div className="text-[12.5px] text-muted">{a.event.location}</div>}
          <div className="mt-1 text-[12.5px] text-muted">
            {a.every ? "every occurrence of the series" : "this one only"}
          </div>
        </div>
      )}
      {a.kind === "mail_move" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div>
            to <span className="font-mono text-[12px]">{a.to}</span>, which the server empties on
            its own
          </div>
          <ul className="mt-1.5 text-[12.5px] text-muted">
            {a.subjects.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {a.kind === "desk_session" && (
        <div className="rounded-md border border-line bg-surface px-3 py-2 text-[13px]">
          <div className="font-medium">{a.title}</div>
          <div className="mt-1 text-[12.5px] whitespace-pre-wrap text-muted">{a.ask}</div>
        </div>
      )}
      {error && (
        <Notice kind="fail" className="mt-2">
          {error}
        </Notice>
      )}
      {!done ? (
        <div className="mt-3 flex items-center gap-2">
          <Button onClick={() => void act("do")} disabled={busy !== null} variant="primary">
            {busy === "do" ? "doing…" : label}
          </Button>
          <Button onClick={() => void act("drop")} disabled={busy !== null}>
            drop
          </Button>
        </div>
      ) : (
        <div className="mt-2 font-mono text-[11px] text-faint">{item.did}</div>
      )}
    </div>
  );
}
