import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type {
  ChatMessage,
  ChatTodo,
  ChatToolCall,
  Session,
  SessionChat,
  SessionPrompt,
  TuiPrompt,
  UploadedFile,
} from "../../../shared/api";
import { api } from "../api";
import { useGrow } from "../useGrow";
import AskCard from "./chat/AskCard";
import Images from "./chat/Images";
import LivePrompt from "./chat/LivePrompt";
import PlanCard from "./chat/PlanCard";
import ToolChip from "./chat/ToolChip";
import { MD } from "./chat/markdown";

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

/**
 * Something that happened to the session rather than in the conversation.
 *
 * One centred line between two hairlines, deliberately the quietest thing on
 * screen: a rail is there to be found when you go looking for when a mode
 * changed or which PR this was, not to be read on the way past.
 */
function Rail({ message }: { message: ChatMessage }) {
  const tone =
    message.event === "error" || message.event === "hook"
      ? "text-fail"
      : message.event === "interrupted"
        ? "text-wait"
        : "text-faint";
  return (
    <div className="flex items-center gap-2.5">
      <span className="h-px flex-1 bg-line" />
      <span className={`flex-none font-mono text-[11px] ${tone}`}>
        {message.event === "pr" && message.href ? (
          <a href={message.href} target="_blank" rel="noreferrer" className="text-accent underline">
            {message.text}
          </a>
        ) : (
          message.text
        )}
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

/** How each mode is coloured, by the label the pane parser returns. */
const MODE_TONE: Record<string, string> = {
  bypass: "border-fail text-fail",
  "don't ask": "border-fail text-fail",
  "accept edits": "border-run text-run",
  auto: "border-run text-run",
  plan: "border-accent text-accent",
  manual: "border-line text-muted",
};

/**
 * The agent's own checklist, pinned rather than in the flow.
 *
 * It is state, not something that was said: drawn where it was written it would
 * sit at whatever point in history the agent last touched it, which is never
 * where you are looking.
 *
 * The permission mode is pinned here too, and on a live session it is a button
 * rather than a label — shift+tab, the same key the terminal's own chip sends.
 * Reading which mode a session is in while being unable to change it without
 * opening the terminal was the gap: the chat can answer a permission prompt but
 * could not stop them being asked.
 */
function Todos({
  todos,
  mode,
  onCycleMode,
}: {
  todos: ChatTodo[];
  mode: string;
  /** Null on a session that has ended — there is nothing left to cycle. */
  onCycleMode: (() => void) | null;
}) {
  const [open, setOpen] = useState(false);
  const done = todos.filter((t) => t.status === "completed").length;
  if (!todos.length && !mode) return null;
  const tone = MODE_TONE[mode] ?? "border-line text-muted";
  return (
    <div className="flex-none border-b border-line bg-surface-2/40 px-3.5 py-1.5">
      <div className="flex items-center gap-2 font-mono text-[11px] text-muted">
        {mode &&
          (onCycleMode ? (
            <button
              onClick={onCycleMode}
              title="cycle permission mode (shift+tab)"
              aria-label={`permission mode: ${mode}. tap to cycle`}
              className={`tap-hit rounded-full border px-2 py-0.5 hover:brightness-125 ${tone}`}
            >
              {mode}
            </button>
          ) : (
            <span className={`rounded-full border px-2 py-0.5 ${tone}`}>{mode}</span>
          ))}
        {todos.length > 0 && (
          <button
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="tap-hit flex items-center gap-1.5 hover:text-text"
          >
            <span>{open ? "▾" : "▸"}</span>
            <span>
              todos {done}/{todos.length}
            </span>
          </button>
        )}
      </div>
      {open && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {todos.map((t, i) => (
            <li
              key={i}
              className={`flex gap-2 text-[12px] ${
                t.status === "completed" ? "text-faint line-through" : "text-muted"
              }`}
            >
              <span className="flex-none font-mono">
                {t.status === "completed" ? "✓" : t.status === "in_progress" ? "▸" : "·"}
              </span>
              <span className="min-w-0">{t.subject}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Turn({
  message,
  sessionId,
  project,
  bytes,
}: {
  message: ChatMessage;
  sessionId: string;
  project: string;
  bytes: number;
}) {
  if (message.role === "event") {
    return <Rail message={message} />;
  }
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent px-3 py-2 text-[14px] font-medium whitespace-pre-wrap text-on-accent">
          {message.text}
        </div>
      </div>
    );
  }
  if (message.ask) {
    return <AskCard ask={message.ask} />;
  }
  if (message.plan) {
    return <PlanCard plan={message.plan} sessionId={sessionId} bytes={bytes} />;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {message.tools.map((t, i) => (
        <ToolChip key={t.id || i} tool={t} sessionId={sessionId} bytes={bytes} />
      ))}
      {message.images && message.images.length > 0 && (
        <Images images={message.images} sessionId={sessionId} project={project} bytes={bytes} />
      )}
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

/**
 * What the session is doing right now, in the one place you are already looking.
 *
 * The status a session carries only tells "needs you" apart from everything
 * else, so the chat had one signal for working — a 6px dot, and only once a
 * tool had been called — and nothing at all for idle. Thinking for two minutes
 * and sitting at an empty prompt looked identical, which is the state people
 * open the terminal to resolve.
 *
 * Three states, one strip, always drawn while the session is live, because a
 * strip that appears only sometimes is one you have to remember the meaning of
 * its absence. The blocked case is not here: LivePrompt owns that slot, and it
 * has the buttons.
 */
function Activity({ busy, doing }: { busy: boolean; doing: string | null }) {
  return (
    <div className="flex flex-none items-center gap-2 border-t border-line px-3.5 py-1.5 font-mono text-[11px]">
      <span
        className={`h-1.5 w-1.5 flex-none rounded-full ${busy ? "animate-pulse bg-run" : "bg-idle"}`}
      />
      <span className={`min-w-0 truncate ${busy ? "text-run" : "text-faint"}`}>
        {busy ? (doing ?? "working…") : "idle · nothing running"}
      </span>
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
  const [todos, setTodos] = useState<ChatTodo[]>([]);
  const [mode, setMode] = useState("");
  const [bytes, setBytes] = useState(WINDOW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [echoes, setEchoes] = useState<Echo[]>([]);
  const [prompt, setPrompt] = useState<TuiPrompt | null>(null);
  const [paneMode, setPaneMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const lookNow = useRef<(() => Promise<void>) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const grow = useGrow(text);
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
    setTodos([]);
    setMode("");
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
      // Replaced rather than appended: both are what the window last saw, so
      // they arrive on every poll including the ones that carry no new turns.
      setTodos(chat.todos);
      setMode(chat.permissionMode);
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

  /**
   * The pane, scraped: what dialog it is drawing, and which mode it is in.
   *
   * The one thing on this screen that does not come from the transcript, and it
   * is deliberately its own request rather than part of `/chat` — that endpoint
   * is a file read and cannot drift from what happened, and folding a scrape
   * into it would make the whole conversation only as trustworthy as the
   * scrape. See the route's own note.
   *
   * Both readings come off one capture. Polled whenever the session is live,
   * because the mode is worth knowing at any moment; the interval is the chat's
   * own, since neither answer changes faster than that except when somebody
   * here presses something — and that path calls `look` directly.
   */
  useEffect(() => {
    if (!live) {
      setPrompt(null);
      setPaneMode(null);
      setBusy(false);
      setDoing(null);
      return;
    }
    let stopped = false;
    async function look() {
      try {
        const res = await api<SessionPrompt>(`/api/sessions/${session.id}/prompt`);
        if (stopped) return;
        setPrompt(res.prompt);
        setPaneMode(res.mode);
        setBusy(res.busy);
        setDoing(res.doing);
      } catch {
        // A pane that cannot be read is not a pane that is asking anything.
        if (!stopped) {
          setPrompt(null);
          setPaneMode(null);
          setBusy(false);
          setDoing(null);
        }
      }
    }
    void look();
    lookNow.current = look;
    const timer = setInterval(() => {
      if (!document.hidden) void look();
    }, 3_000);
    return () => {
      stopped = true;
      lookNow.current = null;
      clearInterval(timer);
    };
  }, [session.id, live]);

  // Follow the conversation, unless the reader has scrolled up to read
  // something — pinning them to the bottom mid-sentence is the whole complaint
  // about the terminal.
  useEffect(() => {
    if (!atBottom.current) return;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, pending, echoes]);

  /**
   * Press a key, which `send` deliberately cannot.
   *
   * That types literally, so "escape" would arrive as six characters in the
   * composer. The route takes a key from a closed set for exactly this: escape
   * stops a working agent, right moves a question with several answers on to
   * the screen that submits them, and shift-tab cycles the permission mode.
   *
   * Then look again straight away. None of these three writes a transcript
   * entry or changes the session's status — they change what the pane draws and
   * nothing else — so without this the result appears whenever the next poll
   * happens to land. Waiting seconds to find out whether a tap registered is
   * how people end up tapping twice, which on a toggle undoes what they did.
   */
  async function press(key: "escape" | "right" | "shift-tab") {
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ key }),
      });
    } catch (e) {
      setError((e as Error).message);
    }
    await lookNow.current?.();
  }

  /**
   * Answer a dialog by pressing the option's number.
   *
   * Without a Return, and that is the whole point of it being its own function.
   * The digit submits on its own — watched against a real trust dialog and a
   * real question, both of which closed on the keypress — so a Return sent
   * after it would land in the composer instead. On an empty one that is
   * harmless, but an agent that is busy queues what you type, and there the
   * stray Return would send a half-written message you had not finished.
   */
  async function answer(digit: string) {
    setSending(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ text: digit, enter: false }),
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
    // Same reason as `press`: a ticked box changes the pane and nothing else.
    await lookNow.current?.();
  }

  /**
   * Put an image where the agent can read it, and name it in the composer.
   *
   * The agent runs on the pod and reads files off disk; the bytes are here, in
   * a browser, so they have to land in the repo before they can be looked at.
   * That is what the project upload route is for — it stamps a unique name,
   * hides the result from git, and hands back a repo-relative path. The path
   * goes into the field rather than being sent, so the message can be written
   * around it, which is the same bargain the terminal's own picker makes.
   *
   * Whatever landed gets named even if a later one failed: three screenshots
   * where the second timed out should still put two paths in the field.
   */
  async function attach(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length || attaching) return;
    setAttaching(true);
    setError(null);
    const paths: string[] = [];
    let failed = false;
    for (const f of images.slice(0, 4)) {
      // A file off the clipboard can arrive nameless, and the route needs one.
      const name = f.name || `pasted.${f.type.split("/")[1] ?? "png"}`;
      try {
        const { path } = await api<UploadedFile>(
          `/api/projects/${encodeURIComponent(session.project)}/upload?filename=${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: await f.arrayBuffer(),
            timeoutMs: 60_000,
          },
        );
        paths.push(path);
      } catch (e) {
        failed = true;
        setError((e as Error).message);
      }
    }
    if (paths.length) {
      setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}${paths.join(" ")} `);
    }
    setAttaching(false);
    if (!failed) grow.current?.focus();
  }

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
      {/* The pane first: it is the only source that is right *now*. The
          transcript's is what the last turn ran in, which is the right thing to
          fall back to when the pane cannot be read or the session has ended,
          and is what this chip always showed before. Cycling stays available
          either way — shift+tab works whether or not the label could be read. */}
      <Todos
        todos={todos}
        mode={paneMode ?? mode}
        onCycleMode={live ? () => void press("shift-tab") : null}
      />
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
          <Turn
            key={m.id}
            message={m}
            sessionId={session.id}
            project={session.project}
            bytes={bytes}
          />
        ))}

        {/* Work in flight: the calls it has made since the last thing it said. */}
        {pending.map((t, i) => (
          <ToolChip key={t.id || `p${i}`} tool={t} sessionId={session.id} bytes={bytes} />
        ))}

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

      {/* A dialog is drawn by the TUI and never written to the transcript, so
          without this the chat looks idle at exactly the moment the agent is
          blocked on an answer. */}
      <LivePrompt
        session={session}
        prompt={prompt}
        onAnswer={answer}
        onKey={press}
        onSend={send}
        sending={sending}
      />

      {/* The same slot, and only one of them at a time: being asked something
          is a state of its own, and LivePrompt draws it with the answers. */}
      {live && !prompt && session.status !== "waiting" && <Activity busy={busy} doing={doing} />}

      {error && (
        <div className="flex-none border-t border-line px-3.5 py-1.5 font-mono text-[12px] text-fail">
          {error}
        </div>
      )}

      {live && (
        <div className="flex flex-none items-end gap-2 border-t border-line px-3 py-2.5">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void attach(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          {/* The phone half of pasting: there is no clipboard route for a
              screenshot on iOS, so the photo library and the camera stand in
              for one. */}
          <button
            onClick={() => fileRef.current?.click()}
            disabled={attaching}
            aria-label="attach an image"
            title="upload an image for it to read"
            className="tap-sq flex-none rounded-lg border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-line-strong hover:text-text disabled:opacity-40"
          >
            {attaching ? "…" : "img"}
          </button>
          <textarea
            ref={grow}
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
            onPaste={(e) => {
              // `files` alone is not enough: a screenshot taken with
              // Win+Shift+S sits on the clipboard as a bitmap rather than as a
              // file, and not every browser synthesises a File for it — `items`
              // carries it and `files` stays empty. A paste carrying only text
              // falls through and pastes as it always did.
              const data = e.clipboardData;
              const carried = data.files.length
                ? Array.from(data.files)
                : Array.from(data.items)
                    .filter((i) => i.kind === "file")
                    .map((i) => i.getAsFile())
                    .filter((f): f is File => f !== null);
              const images = carried.filter((f) => f.type.startsWith("image/"));
              if (!images.length) return;
              e.preventDefault();
              void attach(images);
            }}
            rows={1}
            placeholder={`say something to ${session.agent}…`}
            aria-label="message the agent"
            className="max-h-40 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          {/* Only while it is actually doing something — an esc against an
              idle prompt clears whatever you were halfway through typing. The
              status cannot say that (it reads "running" for an agent sat at an
              empty prompt too); the pane can, which is what `busy` is. */}
          {busy && (
            <button
              onClick={() => void press("escape")}
              aria-label="interrupt"
              title="stop what it is doing"
              className="tap-sq flex-none rounded-lg border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-fail/50 hover:text-fail"
            >
              esc
            </button>
          )}
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
