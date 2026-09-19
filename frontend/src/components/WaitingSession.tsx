import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type { Session, SessionCapture, SessionPrompt } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { AgentTag, StatusChip } from "./StatusChip";
import { SkeletonLines } from "./Skeleton";
import LivePrompt from "./chat/LivePrompt";

/**
 * One agent that wants a decision, answerable without opening its terminal.
 *
 * The last lines it printed are the question, the parsed dialog under them is
 * the answer. The point is the lock-screen case: a push says a session is
 * waiting, and until now the only way to act on it was to open a terminal,
 * wait for the websocket, find the prompt among the TUI chrome, and type into
 * a canvas that has no paste affordance on a phone.
 *
 * Both the capture and the dialog are fetched only while the row is expanded —
 * each is a tmux call per poll, and a queue of ten waiting sessions should not
 * make twenty of them every few seconds. Which also settles where the answers
 * belong: beneath the output, not beside a collapsed row.
 */
export default function WaitingSession({ session }: { session: Session }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { data: capture } = usePoll<SessionCapture>(
    open ? `/api/sessions/${session.id}/capture?lines=24` : null,
    4_000,
  );
  /**
   * What the pane is actually asking, parsed.
   *
   * This row used to offer "yes" and "no" on its own authority, each of which
   * typed a letter and pressed Return — with the output collapsed, so the
   * question had not been seen at all. Return does not choose on these dialogs,
   * it takes whatever the cursor is resting on, which is normally the first
   * option: "yes". From a lock screen, "no" approved. The buttons are the
   * dialog's own now, or there are none.
   *
   * Fetched only while the row is expanded, for the same reason the capture
   * beside it is: both are a tmux call per poll, and a queue of ten waiting
   * sessions should not make twenty of them every few seconds. That it can no
   * longer be answered without expanding is the point rather than the cost —
   * the output and the question are on screen before there is a button.
   */
  const { data: live } = usePoll<SessionPrompt>(
    open ? `/api/sessions/${session.id}/prompt` : null,
    5_000,
  );

  /** Presses one option's number. No Return — see ChatPane's `answer`. */
  async function answer(digit: string) {
    await send({ text: digit, enter: false });
  }

  async function press(key: "escape" | "right") {
    await send({ key });
  }

  async function reply(text: string) {
    await send({ text, enter: true });
  }

  async function send(body: { text?: string; enter?: boolean; key?: string }) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify(body),
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
        <span className="min-w-0 flex-1 truncate text-[13px]">{session.title}</span>
        <AgentTag agent={session.agent} />
        <Link to={`/p/${session.project}`} className="text-[11.5px] text-faint hover:text-accent">
          {session.project}
        </Link>
        <span className="font-mono text-[11px] text-faint">{agoLabel(session.createdAt)}</span>
      </div>

      {session.report && <div className="mt-1.5 text-[12.5px] text-wait">{session.report}</div>}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          onClick={() => setOpen((o) => !o)}
          className="tap rounded-md border border-line px-2.5 py-1 text-[12.5px] text-muted hover:border-faint hover:text-text"
        >
          {open ? "hide" : "show and answer"}
        </button>
        <Link
          to={`/s/${session.id}`}
          className="tap ml-auto flex items-center rounded-md border border-line px-2.5 py-1 text-[12.5px] text-muted hover:border-faint hover:text-text"
        >
          open terminal →
        </Link>
      </div>

      {error && <div className="mt-1.5 text-[12.5px] text-fail">{error}</div>}

      {open && (
        <>
          <pre className="mt-2 max-h-[40dvh] overflow-auto rounded-md border border-line bg-term p-2.5 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap text-muted">
            {capture ? capture.text || "…" : <SkeletonLines count={4} />}
          </pre>
          {/* The question in its own words, with its own answers. The same
              component the session's chat view uses, for the same reason: what
              is drawn is what will be pressed. */}
          <div className="-mx-[15px] mt-2">
            <LivePrompt
              session={session}
              prompt={live?.prompt ?? null}
              onAnswer={answer}
              onKey={press}
              onOpenTerminal={() => void navigate(`/s/${session.id}`)}
              sending={sending}
            />
          </div>
          <Reply onSend={reply} sending={sending} />
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
        className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
      />
      <button
        onClick={send}
        disabled={sending || !text.trim()}
        className="tap flex-none rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-on-accent disabled:opacity-50"
      >
        send
      </button>
    </div>
  );
}
