import { Fragment, memo, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import type { ChatMessage, ChatTodo, Session, UploadedFile } from "../../../shared/api";
import { api } from "../api";
import { useDraft } from "../useDraft";
import { useGrow } from "../useGrow";
import { usePanePrompt } from "../usePanePrompt";
import { useSessionChat } from "../useSessionChat";
import Composer from "./chat/Composer";
import AskCard from "./chat/AskCard";
import Images from "./chat/Images";
import LivePrompt from "./chat/LivePrompt";
import PlanCard from "./chat/PlanCard";
import ToolChip from "./chat/ToolChip";
import Skeleton from "./Skeleton";
import { MD, REMARK } from "./chat/markdown";
import UserBubble from "./chat/UserBubble";
import { scrollBehavior } from "../motion";
import Ago, { DayRule, newDay } from "./Ago";
import CopyButton from "./chat/CopyButton";

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

/**
 * One turn.
 *
 * Memoized, because the poll runs every three seconds whether or not anything
 * was said, and this parses markdown. `merge` hands back the same object for a
 * message that has not changed, so an unchanged turn is not drawn again.
 */
const Turn = memo(function Turn({
  message,
  sessionId,
  project,
}: {
  message: ChatMessage;
  sessionId: string;
  project: string;
}) {
  if (message.role === "event") {
    return <Rail message={message} />;
  }
  if (message.role === "user") {
    return (
      <div className="flex flex-col items-end gap-2">
        {/* Pasted with the words, so drawn with them: above, the way the CLI
            shows them before the prompt they came with. */}
        {message.images && message.images.length > 0 && (
          <Images images={message.images} sessionId={sessionId} project={project} />
        )}
        {message.text && <UserBubble size="sm">{message.text}</UserBubble>}
        <Ago at={message.at} className="-mt-1 font-mono text-[10px] leading-none text-faint" />
      </div>
    );
  }
  if (message.ask) {
    return <AskCard ask={message.ask} />;
  }
  if (message.plan) {
    return <PlanCard plan={message.plan} sessionId={sessionId} />;
  }
  return (
    <div className="flex flex-col gap-2.5">
      {message.tools.map((t, i) => (
        <ToolChip key={t.id || i} tool={t} sessionId={sessionId} />
      ))}
      {message.images && message.images.length > 0 && (
        <Images images={message.images} sessionId={sessionId} project={project} />
      )}
      {message.text && (
        <div className="flex">
          <div className="max-w-[82%] min-w-0 rounded-[14px] rounded-bl-[5px] border border-line bg-surface px-3 py-2 text-[14px]">
            <Markdown components={MD} remarkPlugins={REMARK}>
              {message.text}
            </Markdown>
          </div>
        </div>
      )}
      {message.text && (
        <div className="-mt-1.5 flex items-center gap-2">
          <Ago at={message.at} className="font-mono text-[10px] leading-none text-faint" />
          <CopyButton text={message.text} />
        </div>
      )}
    </div>
  );
});

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
    <div
      role="status"
      className="flex flex-none items-center gap-2 border-t border-line px-3.5 py-1.5 text-[11.5px]"
    >
      <span
        className={`h-1.5 w-1.5 flex-none rounded-full ${busy ? "animate-pulse bg-run" : "bg-idle"}`}
      />
      <span className={`min-w-0 truncate ${busy ? "text-run" : "text-faint"}`}>
        {busy ? (doing ?? "working…") : "idle · nothing running"}
      </span>
    </div>
  );
}

export default function ChatPane({
  session,
  onOpenTerminal,
}: {
  session: Session;
  /** Switches the pane to the terminal; the way out of a dialog nothing here can read. */
  onOpenTerminal: () => void;
}) {
  const {
    messages,
    pending,
    truncated,
    todos,
    mode,
    loading,
    error: readError,
    echoes,
    echo,
    widen,
  } = useSessionChat(session.id);
  const live = session.status !== "done";
  const { prompt, mode: paneMode, busy, doing, look } = usePanePrompt(session.id, live);
  const [error, setError] = useState<string | null>(null);
  // Kept per session across a tap away or a reload (C-21).
  const [text, setText] = useDraft(`vk.draft.session.${session.id}`);
  const [sending, setSending] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  /** The same thing the effect reads, for the thing the screen draws. */
  const [away, setAway] = useState(false);
  /**
   * How far from the bottom the reader was when "load earlier" was pressed.
   *
   * Measured from the bottom rather than the top, because the whole point is
   * that a great deal is about to be inserted above them. Null when nothing is
   * waiting to be put back.
   */
  const keepPlace = useRef<{ fromBottom: number; count: number } | null>(null);
  const grow = useGrow(text);

  /**
   * Follow the conversation, unless the reader has scrolled up to read
   * something — pinning them to the bottom mid-sentence is the whole complaint
   * about the terminal.
   *
   * Before the paint rather than after it, so the older half of a widened
   * window is never briefly seen from the wrong place.
   */
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const kept = keepPlace.current;
    // Only once the longer list has actually landed. A tool chip arriving in
    // the three seconds between the tap and the answer would otherwise spend
    // the restore on a list that had not grown, and the reader would be left
    // looking at whatever the older turns pushed into their view.
    if (kept && messages.length > kept.count) {
      // "Load earlier" just landed: put the reader back on the line they were
      // reading, however much was inserted above it.
      el.scrollTop = el.scrollHeight - kept.fromBottom;
      keepPlace.current = null;
      return;
    }
    if (kept) return;
    if (!atBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, pending, echoes]);

  function toLatest() {
    const el = scroller.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior() });
    atBottom.current = true;
    setAway(false);
  }

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
    await look();
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
    await look();
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
  async function attach(images: File[]) {
    if (!images.length || attaching) return;
    setAttaching(true);
    setError(null);
    const paths: string[] = [];
    let failed = false;
    for (const f of images) {
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

  async function send(raw: string) {
    // Trimmed before it goes, so the echo matches what the transcript keeps: an
    // attached path leaves a trailing space, and the server trims (C-14).
    const value = raw.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await api(`/api/sessions/${session.id}/input`, {
        method: "POST",
        body: JSON.stringify({ text: value, enter: true }),
      });
      echo(value);
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
      {/* Positioned, for the one control that floats over the conversation. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            setAway(!atBottom.current);
          }}
          role="log"
          aria-label="the conversation"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3.5 py-3.5"
        >
          {truncated && (
            <button
              onClick={() => {
                // Where the reader is now, measured from the bottom, so the
                // layout effect can put them back once the longer list lands.
                const el = scroller.current;
                keepPlace.current = el
                  ? { fromBottom: el.scrollHeight - el.scrollTop, count: messages.length }
                  : null;
                widen();
              }}
              className="mx-auto flex-none rounded-full border border-line px-3 py-1 text-[11.5px] text-muted hover:border-faint hover:text-text"
            >
              load earlier
            </button>
          )}

          {/* The rough rhythm of a conversation: your short ask, a longer answer. */}
          {loading && (
            <div className="flex flex-col gap-3">
              <Skeleton className="block h-10 w-2/5 self-end rounded-2xl bg-surface-2" />
              <Skeleton className="block h-24 w-4/5 rounded-2xl bg-surface-2" />
              <Skeleton className="block h-10 w-1/3 self-end rounded-2xl bg-surface-2" />
              <Skeleton className="block h-16 w-3/5 rounded-2xl bg-surface-2" />
            </div>
          )}

          {!loading && messages.length === 0 && (
            <div className="m-auto max-w-[36ch] text-center text-[12.5px] text-faint">
              {session.agent === "claude"
                ? "nothing said yet"
                : `${session.agent} keeps no transcript — use the terminal`}
            </div>
          )}

          {messages.map((m, i) => (
            <Fragment key={m.id}>
              {newDay(messages[i - 1]?.at, m.at) && <DayRule at={m.at} />}
              <Turn message={m} sessionId={session.id} project={session.project} />
            </Fragment>
          ))}

          {/* Work in flight: the calls it has made since the last thing it said. */}
          {pending.map((t, i) => (
            <ToolChip key={t.id || `p${i}`} tool={t} sessionId={session.id} />
          ))}

          {/* Sent from here, not yet in the transcript. An agent that is busy
            queues a prompt rather than taking it, so this can sit for a while —
            which is the honest picture of what happened to it. */}
          {echoes.map((e) => (
            <div key={`e${e.at}`} className="flex justify-end">
              <UserBubble size="sm" pending>
                {e.text}
              </UserBubble>
            </div>
          ))}
        </div>

        {/* Scrolled up to read something, while the agent keeps working: the
            way back, rather than being dragged there by the next thing it
            says. */}
        {away && (
          <button
            onClick={toLatest}
            className="tap absolute bottom-2.5 left-1/2 -translate-x-1/2 rounded-full border border-line bg-surface-2 px-3 py-1 text-[11.5px] text-muted shadow-sm hover:border-accent hover:text-accent"
          >
            latest ↓
          </button>
        )}
      </div>

      {/* A dialog is drawn by the TUI and never written to the transcript, so
          without this the chat looks idle at exactly the moment the agent is
          blocked on an answer. */}
      <LivePrompt
        session={session}
        prompt={prompt}
        onAnswer={answer}
        onKey={press}
        onOpenTerminal={onOpenTerminal}
        sending={sending}
      />

      {/* The same slot, and only one of them at a time: being asked something
          is a state of its own, and LivePrompt draws it with the answers. */}
      {live && !prompt && session.status !== "waiting" && <Activity busy={busy} doing={doing} />}

      {(error ?? readError) && (
        <div
          role="alert"
          className="flex-none border-t border-line px-3.5 py-1.5 text-[12.5px] text-fail"
        >
          {error ?? readError}
        </div>
      )}

      {live && (
        <div className="flex-none border-t border-line px-2.5 pt-2.5 pb-2.5">
          <Composer
            value={text}
            onChange={setText}
            onSend={() => void send(text)}
            onAttach={(files) => void attach(files)}
            onRefused={setError}
            attaching={attaching}
            canSend={!sending && !!text.trim()}
            label="message the agent"
            placeholder={`say something to ${session.agent}…`}
            fieldRef={grow}
          >
            {/* Only while it is actually doing something — an esc against an
                idle prompt clears whatever you were halfway through typing. The
                status cannot say that (it reads "running" for an agent sat at
                an empty prompt too); the pane can, which is what `busy` is. */}
            {busy && (
              <button
                onClick={() => void press("escape")}
                aria-label="interrupt"
                title="stop what it is doing"
                className="tap-sq flex h-9 flex-none items-center rounded-xl px-2.5 font-mono text-[12px] text-muted hover:bg-line-strong/40 hover:text-fail"
              >
                esc
              </button>
            )}
          </Composer>
        </div>
      )}
    </div>
  );
}
