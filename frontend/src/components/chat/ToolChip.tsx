import { useState } from "react";
import Markdown from "react-markdown";
import type { ChatDetail, ChatToolCall } from "../../../../shared/api";
import { api } from "../../api";
import { diffLineClass } from "../../diff";
import { MD } from "./markdown";

/**
 * One thing the agent did, and — when you ask — what it actually did.
 *
 * The chip is an address rather than a summary. What a call printed is the bulk
 * of a transcript and the reason a terminal is hard to read, so none of it
 * rides the poll; tapping fetches that one call by the id the chip carries.
 * A test run that printed a megabyte costs the same as `ls` until somebody
 * wants to read it, and then it costs one request.
 *
 * The detail is held here rather than in the pane above. Chips never unmount —
 * the conversation only ever grows — so a call fetched once stays fetched, and
 * nothing has to be remembered on its behalf.
 */
export default function ToolChip({
  tool,
  sessionId,
  bytes,
}: {
  tool: ChatToolCall;
  sessionId: string;
  bytes: number;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [failedToLoad, setFailedToLoad] = useState(false);

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (detail || !tool.id) return;
    try {
      const query = new URLSearchParams({ ref: tool.id, bytes: String(bytes) });
      setDetail(await api<ChatDetail>(`/api/sessions/${sessionId}/chat/detail?${query}`));
    } catch {
      setFailedToLoad(true);
    }
  }

  return (
    <div className="flex max-w-full flex-col gap-2.5 self-start">
      <button
        onClick={() => void toggle()}
        aria-expanded={open}
        disabled={!tool.id}
        className={`tap-hit inline-flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1 text-left font-mono text-[11px] disabled:cursor-default ${
          tool.failed ? "border-fail/40 bg-fail/5 text-fail" : "border-line bg-surface-2 text-muted"
        } ${tool.id ? "hover:border-faint hover:text-text" : ""}`}
      >
        <span className="flex-none">{tool.failed ? "✕" : "✓"}</span>
        <span className="truncate">
          {tool.name}
          {tool.detail && <span className="text-faint"> · {tool.detail}</span>}
        </span>
        {tool.id && <span className="flex-none text-faint">{open ? "▾" : "▸"}</span>}
      </button>

      {open && (
        <div className="min-w-0 overflow-hidden rounded-md border border-line bg-term">
          {!detail && !failedToLoad && (
            <p className="px-2.5 py-2 font-mono text-[11px] text-faint">reading it back…</p>
          )}
          {failedToLoad && (
            <p className="px-2.5 py-2 font-mono text-[11px] text-fail">could not read it back</p>
          )}
          {detail?.kind === "none" && (
            <p className="px-2.5 py-2 font-mono text-[11px] text-faint">
              that call is older than the part of the conversation loaded — load earlier to reach it
            </p>
          )}
          {/* A subagent kept a conversation of its own. Nested rather than
              flattened into this one: read in line it is the agent suddenly
              talking to itself about a job you did not watch it start. */}
          {detail?.kind === "agent" && (
            <div className="flex flex-col gap-2 px-2.5 py-2">
              <p className="font-mono text-[11px] text-faint">
                {detail.agentType || "agent"}
                {detail.description && ` · ${detail.description}`}
              </p>
              {detail.truncated && (
                <p className="font-mono text-[11px] text-faint">
                  only the end of what it did is kept here
                </p>
              )}
              {detail.messages.length === 0 && (
                <p className="font-mono text-[11px] text-faint">it wrote nothing down</p>
              )}
              {detail.messages.map((m) => (
                <div key={m.id} className="flex flex-col gap-1">
                  {m.tools.map((t, i) => (
                    <span key={t.id || i} className="self-start font-mono text-[11px] text-faint">
                      {t.failed ? "✕" : "✓"} {t.name}
                      {t.detail && ` · ${t.detail}`}
                    </span>
                  ))}
                  {m.text && (
                    <div
                      className={`text-[13px] ${
                        m.role === "user" ? "text-muted italic" : "text-text"
                      }`}
                    >
                      <Markdown components={MD}>{m.text}</Markdown>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          {detail?.kind === "plan" && (
            <div className="px-2.5 py-2 text-[13px]">
              <Markdown components={MD}>{detail.markdown}</Markdown>
            </div>
          )}
          {detail?.kind === "tool" && (
            <>
              {detail.input && (
                <pre className="overflow-x-auto border-b border-line px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap text-text">
                  {detail.input}
                </pre>
              )}
              {/* An edit is the one result worth drawing rather than printing. */}
              {detail.patch.length > 0 && (
                <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[12px]">
                  {detail.patch.map((line, i) => (
                    <div key={i} className={diffLineClass(line)}>
                      {line || " "}
                    </div>
                  ))}
                </pre>
              )}
              {detail.patch.length === 0 && detail.output && (
                <pre
                  className={`overflow-x-auto px-2.5 py-2 font-mono text-[12px] whitespace-pre-wrap ${
                    detail.failed ? "text-fail" : "text-muted"
                  }`}
                >
                  {detail.output}
                </pre>
              )}
              {detail.patch.length === 0 && !detail.output && (
                <p className="px-2.5 py-2 font-mono text-[11px] text-faint">
                  it printed nothing back
                </p>
              )}
              {detail.truncated && (
                <p className="border-t border-line px-2.5 py-1.5 font-mono text-[11px] text-faint">
                  cut here — the rest is only readable in the terminal
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
