import { useEffect, useRef, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import type { ChatMessage, ChatToolCall, Session, SessionChat } from "../../../shared/api";
import { api } from "../api";

/**
 * A session read as a conversation.
 *
 * The terminal stays the way to drive an agent; this is the way to read one.
 * xterm on a phone is 40 columns of TUI redraw, the answer scrolls off the top
 * behind whatever it just ran, and none of it can be selected. The same session
 * as bubbles is the same information at a glance, and it works on a session
 * that ended weeks ago, which a terminal cannot do at all.
 *
 * It costs a file read: the backend parses the transcript the agent already
 * writes (see backend/src/chat.ts). Nothing here asks a model anything.
 */

function ToolChip({ tool }: { tool: ChatToolCall }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-2 self-start rounded-full border px-2.5 py-1 font-mono text-[11px] ${
        tool.failed ? "border-fail/40 bg-fail/5 text-fail" : "border-line bg-surface-2 text-muted"
      }`}
    >
      <span className="flex-none">{tool.failed ? "✕" : "✓"}</span>
      <span className="truncate">
        {tool.name}
        {tool.detail && <span className="text-faint"> · {tool.detail}</span>}
      </span>
    </span>
  );
}

/**
 * How an agent writes: headings, bold, bullets, and a great deal of `code`.
 * Left as source it is worse than the terminal it replaces — asterisks and
 * hashes through the middle of every sentence.
 *
 * react-markdown builds React elements rather than HTML, so nothing here can
 * inject markup, and no raw-HTML plugin is added. The element map is the
 * styling: this app has no typography plugin, and a paragraph with browser
 * defaults inside a chat bubble looks broken.
 */
const MD: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12.5px]">{children}</code>
  ),
  // A fenced block: the <code> above is still inside it, so the padding and
  // background come off here to avoid a box in a box.
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md border border-line bg-term p-2.5 font-mono text-[12px] last:mb-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-line pl-3 text-muted last:mb-0">
      {children}
    </blockquote>
  ),
};

function Turn({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent px-3 py-2 text-[14px] font-medium whitespace-pre-wrap text-on-accent">
          {message.text}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {message.tools.map((t, i) => (
        <ToolChip key={i} tool={t} />
      ))}
      {message.text && (
        <div className="flex">
          <div className="max-w-[82%] min-w-0 rounded-[14px] rounded-bl-[5px] border border-line bg-surface px-3 py-2 text-[14px]">
            <Markdown components={MD}>{message.text}</Markdown>
          </div>
        </div>
      )}
    </div>
  );
}

/** A message sent from here that the transcript has not echoed back yet. */
interface Echo {
  text: string;
  at: number;
}

/** How long an unmatched echo stays on screen before it is assumed swallowed. */
const ECHO_TTL_MS = 90_000;

/** Tail of the transcript to ask for; "load earlier" widens it. Matches the
    backend's default, and its ceiling. */
const WINDOW = 256_000;
const MAX_WINDOW = 8_000_000;

export default function ChatPane({ session }: { session: Session }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatToolCall[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [bytes, setBytes] = useState(WINDOW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const live = session.status !== "done";

  /**
   * Poll, and append.
   *
   * Not usePoll: this is the one screen that accumulates rather than replaces.
   * Each request carries the newest timestamp already held, so a poll that
   * finds nothing new costs one repeated turn instead of the whole window every
   * few seconds down a phone tunnel. usePoll would key its effect on that
   * changing URL and reset the list on every new message, which is the opposite
   * of what a conversation wants.
   */
  useEffect(() => {
    let stopped = false;
    let since: string | null = null;
    let conversation: string | null = null;
    setMessages([]);
    setPending([]);
    setLoading(true);

    async function tick() {
      const query = new URLSearchParams({ bytes: String(bytes) });
      if (since) query.set("since", since);
      let chat: SessionChat;
      try {
        chat = await api<SessionChat>(`/api/sessions/${session.id}/chat?${query}`);
      } catch (e) {
        if (!stopped) setError((e as Error).message);
        return;
      }
      if (stopped) return;
      setError(null);
      setLoading(false);
      // A different conversation is a different transcript, and the timestamp
      // held is meaningless against it. Drop everything and let the next tick
      // fetch the new one whole.
      if (conversation !== null && chat.conversationId !== conversation) {
        since = null;
        setMessages([]);
        conversation = chat.conversationId;
        return;
      }
      conversation = chat.conversationId;
      setTruncated(chat.truncated);
      setPending(chat.pending);
      if (chat.messages.length) {
        since = chat.messages.at(-1)!.at || since;
        setMessages((prev) => {
          // By id rather than by position. The newest turn is deliberately
          // re-sent on every poll (see readChat), and a widened window overlaps
          // what is already held, so the transcript's own id is the authority.
          const seen = new Set(prev.map((m) => m.id));
          const fresh = chat.messages.filter((m) => !seen.has(m.id));
          return fresh.length ? [...prev, ...fresh] : prev;
        });
        // Anything the transcript now shows as said is no longer in flight.
        const said = chat.messages.filter((m) => m.role === "user").map((m) => m.text);
        setEchoes((prev) =>
          prev.filter((e) => !said.includes(e.text) && Date.now() - e.at < ECHO_TTL_MS),
        );
      }
    }

    void tick();
    const timer = setInterval(() => {
      if (!document.hidden) void tick();
    }, 3_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session.id, bytes]);

  // Follow the conversation, unless the reader has scrolled up to read
  // something — pinning them to the bottom mid-sentence is the whole complaint
  // about the terminal.
  useEffect(() => {
    if (!atBottom.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, echoes]);

  async function send(value: string) {
    if (!value.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ text: value, enter: true }),
      });
      setEchoes((prev) => [...prev, { text: value, at: Date.now() }]);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5"
      >
        {truncated && (
          <button
            onClick={() => setBytes((b) => Math.min(b * 4, MAX_WINDOW))}
            className="mx-auto flex-none rounded-full border border-line px-3 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
          >
            load earlier
          </button>
        )}

        {loading && <div className="font-mono text-[12px] text-faint">reading the transcript…</div>}

        {!loading && messages.length === 0 && (
          <div className="m-auto max-w-[36ch] text-center font-mono text-[12px] text-faint">
            {session.agent === "claude"
              ? "nothing said yet"
              : `${session.agent} keeps no transcript — use the terminal`}
          </div>
        )}

        {messages.map((m) => (
          <Turn key={m.id} message={m} />
        ))}

        {/* Work in flight: the calls it has made since the last thing it said. */}
        {pending.map((t, i) => (
          <ToolChip key={`p${i}`} tool={t} />
        ))}
        {live && pending.length > 0 && (
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        )}

        {/* Sent from here, not yet in the transcript. An agent that is busy
            queues a prompt rather than taking it, so this can sit for a while —
            which is the honest picture of what happened to it. */}
        {echoes.map((e, i) => (
          <div key={`e${i}`} className="flex justify-end">
            <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent/40 px-3 py-2 text-[14px] font-medium whitespace-pre-wrap text-on-accent opacity-70">
              {e.text}
            </div>
          </div>
        ))}
      </div>

      {session.status === "waiting" && (
        // A permission prompt is drawn by the TUI and never written to the
        // transcript, so without this the chat looks idle at exactly the moment
        // the agent is blocked on an answer.
        <div className="flex flex-none flex-wrap items-center gap-2 border-t border-wait/40 bg-wait/5 px-3.5 py-2 font-mono text-[12px] text-wait">
          <span className="min-w-0 flex-1">it is waiting for you</span>
          <button
            onClick={() => void send("y")}
            disabled={sending}
            className="tap rounded-md border border-run/50 px-2.5 py-1 text-run disabled:opacity-50"
          >
            yes
          </button>
          <button
            onClick={() => void send("n")}
            disabled={sending}
            className="tap rounded-md border border-fail/50 px-2.5 py-1 text-fail disabled:opacity-50"
          >
            no
          </button>
        </div>
      )}

      {error && (
        <div className="flex-none border-t border-line px-3.5 py-1.5 font-mono text-[12px] text-fail">
          {error}
        </div>
      )}

      {live && (
        <div className="flex flex-none items-end gap-2 border-t border-line px-3 py-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+enter breaks the line — the same bargain the
              // assistant's composer makes.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send(text);
              }
            }}
            rows={1}
            placeholder={`say something to ${session.agent}…`}
            aria-label="message the agent"
            className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <button
            onClick={() => void send(text)}
            disabled={sending || !text.trim()}
            aria-label="send"
            className="tap-sq flex-none rounded-lg bg-accent px-3 py-1.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-40"
          >
            ↑
          </button>
        </div>
      )}
    </div>
  );
}
