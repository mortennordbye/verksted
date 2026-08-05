import { useState } from "react";
import { Link } from "react-router";
import type { Session, SessionCapture } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { AgentTag, StatusChip } from "./StatusChip";

/**
 * One agent that wants a decision, answerable without opening its terminal.
 *
 * The last lines it printed are the question; the buttons are the answer. The
 * point is the lock-screen case: a push says a session is waiting, and until
 * now the only way to act on it was to open a terminal, wait for the websocket,
 * find the prompt among the TUI chrome, and type into a canvas that has no
 * paste affordance on a phone.
 *
 * Capture is fetched only while the row is expanded — it is a tmux call per
 * poll, and a queue of ten waiting sessions should not make ten of them every
 * few seconds.
 */
export default function WaitingSession({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: capture } = usePoll<SessionCapture>(
    open ? `/api/sessions/${session.id}/capture?lines=24` : null,
    4_000,
  );

  async function answer(text: string) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ text, enter: true }),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded-[11px] border border-wait/40 bg-surface px-[15px] py-2.5">
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusChip kind="wait" label="waiting" />
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px]">{session.title}</span>
        <AgentTag agent={session.agent} />
        <Link to={`/p/${session.project}`} className="font-mono text-[11px] text-faint hover:text-accent">
          {session.project}
        </Link>
        <span className="font-mono text-[11px] text-faint">{agoLabel(session.createdAt)}</span>
      </div>

      {session.report && <div className="mt-1.5 text-[12.5px] text-wait">{session.report}</div>}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="tap rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted hover:border-faint hover:text-text"
        >
          {open ? "hide output" : "show output"}
        </button>
        {/* The two answers a permission prompt actually wants. */}
        <button
          onClick={() => answer("y")}
          disabled={sending}
          className="tap rounded-md border border-run/50 px-2.5 py-1 font-mono text-[12px] text-run disabled:opacity-50"
        >
          yes
        </button>
        <button
          onClick={() => answer("n")}
          disabled={sending}
          className="tap rounded-md border border-fail/50 px-2.5 py-1 font-mono text-[12px] text-fail disabled:opacity-50"
        >
          no
        </button>
        <Link
          to={`/s/${session.id}`}
          className="tap ml-auto flex items-center rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted hover:border-faint hover:text-text"
        >
          open terminal →
        </Link>
      </div>

      {error && <div className="mt-1.5 font-mono text-[12px] text-fail">{error}</div>}

      {open && (
        <>
          <pre className="mt-2 max-h-[40dvh] overflow-auto rounded-md border border-line bg-term p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
            {capture?.text || "…"}
          </pre>
          <Reply onSend={answer} sending={sending} />
        </>
      )}
    </div>
  );
}

/** A real input, which is the only place a phone can paste. */
function Reply({ onSend, sending }: { onSend: (text: string) => void; sending: boolean }) {
  const [text, setText] = useState("");
  const send = () => {
    if (!text.trim()) return;
    onSend(text);
    setText("");
  };
  return (
    <div className="mt-2 flex gap-2">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && send()}
        placeholder="type a reply…"
        aria-label="reply to the agent"
        className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
      />
      <button
        onClick={send}
        disabled={sending || !text.trim()}
        className="tap flex-none rounded-md bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-[#16130a] disabled:opacity-50"
      >
        send
      </button>
    </div>
  );
}
