import { useState } from "react";
import Markdown from "react-markdown";
import type { ChatDetail, ChatPlan } from "../../../../shared/api";
import { api } from "../../api";
import { MD } from "./markdown";

/**
 * A plan put up for approval.
 *
 * Collapsed it is a title and a verdict, which is what you want when scrolling
 * back through a session looking for where it was decided. Opened it is the
 * whole thing, fetched on demand — a plan runs to thousands of words and there
 * is no reason for every poll to carry one.
 *
 * It expands in place rather than into a sheet: a plan is prose to be read at
 * length, and a panel pinned to the bottom of the screen is the wrong shape for
 * that.
 */
export default function PlanCard({
  plan,
  sessionId,
  bytes,
}: {
  plan: ChatPlan;
  sessionId: string;
  bytes: number;
}) {
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (markdown !== null || !plan.id) return;
    try {
      const query = new URLSearchParams({ ref: plan.id, bytes: String(bytes) });
      const detail = await api<ChatDetail>(`/api/sessions/${sessionId}/chat/detail?${query}`);
      setMarkdown(detail.kind === "plan" ? detail.markdown : "");
    } catch {
      setFailedToLoad(true);
    }
  }

  const verdict =
    plan.approved === null
      ? { label: "waiting on you", tone: "border-wait/50 text-wait" }
      : plan.approved
        ? { label: "approved", tone: "border-run/50 text-run" }
        : { label: "sent back", tone: "border-line text-faint" };

  return (
    <div className="flex flex-col rounded-[14px] border border-line bg-surface-2/50">
      <button
        onClick={() => void toggle()}
        aria-expanded={open}
        disabled={!plan.id}
        className="tap flex items-start gap-2 p-3 text-left"
      >
        <span className="flex-none pt-0.5 font-mono text-[11px] text-faint">
          {open ? "▾" : "▸"}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[14px] font-medium text-text">{plan.title}</span>
          <span className="flex flex-wrap items-center gap-2 font-mono text-[10px]">
            <span className={`rounded-full border px-2 py-0.5 ${verdict.tone}`}>
              {verdict.label}
            </span>
            <span className="text-faint">{plan.chars.toLocaleString()} characters</span>
          </span>
        </span>
      </button>

      {open && (
        <div className="border-t border-line px-3 py-2.5 text-[13.5px]">
          {markdown === null && !failedToLoad && (
            <p className="font-mono text-[11px] text-faint">reading it back…</p>
          )}
          {failedToLoad && (
            <p className="font-mono text-[11px] text-fail">could not read it back</p>
          )}
          {markdown === "" && (
            <p className="font-mono text-[11px] text-faint">
              that plan is older than the part of the conversation loaded — load earlier to reach it
            </p>
          )}
          {markdown && <Markdown components={MD}>{markdown}</Markdown>}
        </div>
      )}
    </div>
  );
}
