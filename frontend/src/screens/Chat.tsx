import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { AssistantThread, CouncilMember, CreatedSession } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { scrollBehavior } from "../motion";
import { threadCost } from "../threadCost";
import Dock, { BrowserView, DESK } from "../components/assistant/Dock";
import Month from "../components/assistant/Month";
import People from "../components/assistant/People";
import Threads from "../components/assistant/Threads";
import Composer, { Ico } from "../components/chat/Composer";
import Portrait from "../components/Face";
import Icon, { type IconName } from "../components/Icon";
import Room from "../components/Room";
import Button from "../components/ui/Button";
import { Input } from "../components/ui/Field";
import { useFindMarks } from "../find";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import { readStored, writeStored } from "../storage";
import Skeleton from "../components/Skeleton";
import { adopt, useAssistantStream } from "../useAssistantStream";
import { useDraft } from "../useDraft";
import { useGrow } from "../useGrow";
import { useReadAloud } from "../useReadAloud";
import { canListen, canSpeak, useSpeech } from "../useSpeech";
import { useVisualViewport } from "../useVisualViewport";

/**
 * The conversation, and the only room there is.
 *
 * One thread, whoever answers in it: the assistant alone, or a specialist it
 * brings in, whose answer lands as a card in their own colour. The council
 * was a second screen with a thread of its own; that made the person route
 * every question before asking it, so it is gone, and what it was for happens
 * here without being asked for. Addressing one of them by name is still
 * possible — typing `@id` first, or "ask" in the specialists panel, writes the
 * `@id` the server reads — but it is a shortcut past a decision that is made
 * for you, not one you have to make.
 *
 * The thread arrives whole over a websocket rather than being polled or
 * diffed: it is a few kilobytes, and a diff protocol would be the only
 * stateful thing in this app. The POST that sends a turn also returns the
 * thread, so a send works even if the socket is down — the socket is what makes
 * a second device watching the same thread stay in step.
 */

/** The chair before the roster has arrived, so the room has a seat to draw. */
const NO_CHAIR: CouncilMember = {
  id: "chair",
  name: "Assistant",
  remit: "",
  persona: "",
  model: "",
  effort: "low",
  tools: [],
  web: false,
  colour: "amber",
  face: "raccoon",
  voice: "",
  chair: true,
  enabled: true,
};

/**
 * One of the header's controls, as an icon with its words in the tooltip.
 *
 * Icons alone because the row also carries who you are talking to, and five
 * worded buttons beside a name did not share a line. `on` is only for the
 * ones that stay on (reading aloud, an open panel), which light up; the rest
 * are actions and carry no pressed state at all.
 */
function ToolButton({
  icon,
  title,
  onClick,
  on,
  disabled,
}: {
  icon: IconName;
  title: string;
  onClick: () => void;
  on?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={on}
      className={`tap-sq flex h-8 w-8 items-center justify-center rounded-lg transition-colors disabled:opacity-40 ${
        on ? "bg-accent-tint text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <Icon name={icon} size={17} />
    </button>
  );
}

export default function Chat() {
  // Socket, reconnect and the fetch that stands in while there is none.
  const { thread, setThread, streaming } = useAssistantStream();
  // Kept across a tap on a citation chip or a reload (C-21).
  const [text, setText] = useDraft("vk.draft.assistant");
  const grow = useGrow(text);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [attaching, setAttaching] = useState(false);
  /**
   * What has been sent and not yet answered by the server, drawn at once
   * rather than when the POST comes back (C-13). Usually a few milliseconds;
   * down a bad tunnel it is the only sign the tap landed.
   */
  const [sending, setSending] = useState<{ stamp: number; text: string }[]>([]);
  /** The next message is put to the specialists to talk over (C-26). */
  const [roundTable, setRoundTable] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  // Gabriel's own browser (chair-only, see assistant.ts's mcpConfig). Not
  // remembered across reloads, the way the session screen's toggle isn't
  // either: a hidden pane still streaming frames is the thing that switch
  // exists to avoid.
  // The calendar shares its half of the screen, one panel at a time.
  const [panel, setPanel] = useState<"browser" | "calendar" | "people" | null>(null);
  // Hands-free: replies are read out, and the microphone reopens when the
  // reading stops, so a whole exchange happens without touching the screen.
  const [voiceMode, setVoiceMode] = useState(false);
  // Read replies out without any of the rest of it. Voice mode answers "I want
  // to talk to it"; this answers "I want to hear it", which is the case where
  // you type a question and then look away. Kept apart because the coupling was
  // the complaint: wanting to be read to meant having the microphone open.
  // Remembered per device: whoever wants it wants it always.
  const [speakReplies, setSpeakReplies] = useState(() => readStored("vk.assistant.speak") === "1");
  /** Whether the end of the conversation is on screen; see the scroll effect. */
  const [atLatest, setAtLatest] = useState(true);
  // Find inside the open thread (C-30): the threads list searches across
  // threads, and a long one had no way to get back to what was said in it.
  const [finding, setFinding] = useState(false);
  const [find, setFind] = useState("");
  const query = finding ? find.trim() : "";
  const room = useRef<HTMLElement>(null);
  const { hits, jump } = useFindMarks(room, query, thread?.entries);
  // The roster changes when somebody edits it in settings, which is rarely, so
  // it is polled slowly rather than pushed: the header shows the chair, and a
  // specialist's card is drawn in its own colour when one answers.
  const { data: roster } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const members = roster ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const chair = members.find((m) => m.chair) ?? NO_CHAIR;

  // Sets `data-kbd`, which hides the tab bar and drops the composer onto the
  // keys: left where they were, the two floated above a band of nothing.
  useVisualViewport();

  // This is the one door whose field is always on screen, and iOS leaves the
  // fixed tab bar resting at the offset it had while the keyboard was up
  // instead of the real one once it closes. The visual viewport returning to
  // full height means the keyboard just went away; nudging scroll by nothing
  // forces Safari to re-lay the fixed elements against the viewport it now has.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      if (innerHeight - vv.height < 40) window.scrollTo(0, window.scrollY);
    };
    vv.addEventListener("resize", onResize);
    return () => vv.removeEventListener("resize", onResize);
  }, []);

  /**
   * Follow the conversation as it grows, the way a conversation is expected
   * to: an answer landing under the question is worth scrolling to.
   *
   * Unless the reader has gone up to read something. This used to scroll on
   * every tick of the reply being written — ten times a second — so going back
   * to check what was asked three answers ago was not possible at all while
   * the chair was talking: the screen snapped to the bottom mid-sentence.
   */
  useEffect(() => {
    if (!atLatest) return;
    scrollTo({ top: document.documentElement.scrollHeight, behavior: scrollBehavior() });
  }, [
    thread?.entries.length,
    thread?.status,
    thread?.live,
    thread?.liveThinking,
    thread?.liveTools,
    atLatest,
  ]);

  // Whether the bottom is on screen. The margin is generous on purpose: the
  // composer and the tab bar sit over the last few lines.
  useEffect(() => {
    const onScroll = () => {
      setAtLatest(innerHeight + scrollY >= document.documentElement.scrollHeight - 120);
    };
    onScroll();
    addEventListener("scroll", onScroll, { passive: true });
    return () => removeEventListener("scroll", onScroll);
  }, []);

  const thinking = thread?.status === "thinking";

  /** Upload first, then send names: the server owns where an image lands. */
  async function attach(files: File[]) {
    const ok = ["png", "jpg", "jpeg", "gif", "webp"];
    setAttaching(true);
    for (const file of files) {
      const type = (file.type.split("/")[1] ?? "").toLowerCase();
      if (!ok.includes(type)) {
        setError(`${file.name} is not an image I can send`);
        continue;
      }
      try {
        const { name } = await api<{ name: string }>(`/api/assistant/uploads?type=${type}`, {
          method: "POST",
          headers: { "content-type": file.type },
          body: await file.arrayBuffer(),
          timeoutMs: 60_000,
        });
        setPending((p) => [...p, name]);
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setAttaching(false);
  }

  /**
   * A message that is only an address and no question.
   *
   * `@uriel` with nothing after it is a name typed and a question not yet, so
   * sending one is a slip rather than a thing anyone means. The backend
   * reads it as unaddressed and hands the chair a message with no question in
   * it, which cost two model calls to be told it was empty. A bare `@` is the
   * same slip one character earlier.
   */
  const addressOnly = (value: string) => /^@[a-z0-9-]*$/i.test(value);

  async function send(spoken?: string) {
    const value = (spoken ?? text).trim();
    if (!value && !pending.length) return;
    // Typed, not tapped: the two words every other agent surface answers to,
    // which went to the chair as a question about nothing and came back saying
    // the turn had produced nothing. Not mid-turn, like the new thread button.
    if (!spoken && (value === "/clear" || value === "/new")) {
      if (thinking) return;
      setText("");
      await newThread();
      return;
    }
    if (!pending.length && addressOnly(value)) return;
    const images = pending;
    if (!spoken) setText("");
    setPending([]);
    await post(value, images, spoken ? "spoken" : "typed");
  }

  /**
   * One message to the server, which asks it now or queues it behind the turn
   * that is running. The queue used to live here, and a reload or a phone
   * locking lost what was in it. A failure puts what was sent back to be sent
   * again.
   */
  async function post(value: string, images: string[], from: "typed" | "spoken" | "retry") {
    setError(null);
    const stamp = Date.now() + Math.random();
    setSending((s) => [...s, { stamp, text: value || "(see image)" }]);
    try {
      // Answered as soon as the question is on record (`wait: false`): the
      // socket carries the turn, and a request held open for a whole meeting is
      // one the tunnel gives up on first. What can still come back as an error
      // is a refusal: a turn already running, a pod that cannot be reached.
      const accepted = await api<AssistantThread>("/api/assistant/messages", {
        method: "POST",
        body: JSON.stringify({
          text: value || "(see image)",
          images,
          wait: false,
          ...(roundTable ? { roundTable: true } : {}),
        }),
      });
      setThread((had) => adopt(had, accepted));
    } catch (e) {
      setError((e as Error).message);
      // Only into an empty field, so it never overwrites what is being typed.
      if (from === "typed") setText((t) => (t.trim() ? t : value));
      setPending((p) => [...images, ...p]);
    } finally {
      setSending((s) => s.filter((m) => m.stamp !== stamp));
    }
  }

  /**
   * "edit" on your last message: back into the composer to change and send as
   * a new one (C-30). Never over a draft, which would lose what was typed.
   */
  function edit(value: string, images: string[]) {
    if (text.trim() || pending.length) {
      setError("send or clear what is in the box first, then edit");
      return;
    }
    setText(value === "(see image)" ? "" : value);
    setPending(images);
    grow.current?.focus();
  }

  /** "try again" on a failed reply. Queued on the server if a turn is running. */
  function retry(text: string, images: string[]) {
    void post(text === "(see image)" ? "" : text, images, "retry");
  }

  // Below send, which it calls: the lint's compiler check will not have a
  // callback reach a function declared further down.
  const speech = useSpeech((said) => void send(said));
  const { listening, speaking, transcribing } = speech;
  // Dictation has no pill of its own, so why it stopped is said on the error
  // line; voice mode says it in its pill (C-20).
  const shownError = error ?? (voiceMode ? null : speech.error);

  // A new function every render is fine: the hook reads it through a ref.
  const voiceOf = (e: { member?: string }) =>
    e.member ? byId.get(e.member)?.voice || undefined : undefined;
  const { markRead } = useReadAloud({
    thread,
    on: voiceMode || speakReplies,
    speak: speech.speak,
    voiceOf,
    // Only hands-free reopens the microphone. Reading a typed exchange aloud
    // must not start listening, or the next thing typed competes with an open
    // mic and the reply gets sent twice.
    onDone: () => {
      if (voiceMode) void speech.listen();
    },
  });

  /**
   * Read replies aloud, without opening the microphone.
   *
   * The short utterance on the way on is not a flourish: iOS will only speak
   * from inside a user gesture until it has spoken once, so a silent switch
   * would be a switch that does nothing until the turn after next. It also
   * tells you the sound is on and which voice you are getting, before you have
   * asked anything.
   */
  function toggleSpeakReplies() {
    const next = !speakReplies;
    setSpeakReplies(next);
    writeStored("vk.assistant.speak", next ? "1" : "0");
    if (next) {
      // Whatever is already on screen has been read, or was never meant to be.
      markRead(thread?.entries ?? []);
      // Said out loud here rather than left for the first reply: this tap is
      // the user gesture iOS wants before any audio may play without one, and
      // speak takes it — for the pod's voice as much as the browser's.
      speech.speak("ok");
    } else if (!voiceMode) {
      speech.cancelSpeech();
    }
  }

  function toggleVoice() {
    if (voiceMode) {
      setVoiceMode(false);
      speech.cancelSpeech();
      speech.stopListening();
      return;
    }
    // Turning it on is the user gesture iOS requires before it will ever speak,
    // so prime it here rather than on the first reply.
    setVoiceMode(true);
    markRead(thread?.entries ?? []);
    void speech.listen();
  }

  // Both say when they fail (C-12): a stop that did not reach the pod leaves a
  // turn spending, and a new thread that was refused must not blank the one
  // still open.
  async function stop() {
    setError(null);
    try {
      await api("/api/assistant/stop", { method: "POST" });
    } catch (e) {
      setError(`could not stop it: ${(e as Error).message}`);
    }
  }

  const navigate = useNavigate();
  /** The thread as a terminal, forked so the chat's own conversation is untouched. */
  async function openInTerminal() {
    if (!thread) return;
    setError(null);
    try {
      const s = await api<CreatedSession>(
        `/api/assistant/threads/${thread.conversationId}/terminal`,
        { method: "POST" },
      );
      void navigate(`/s/${s.id}`);
    } catch (e) {
      setError(`could not open it in a terminal: ${(e as Error).message}`);
    }
  }

  async function newThread() {
    setError(null);
    try {
      const { conversationId } = await api<{ conversationId: string }>("/api/assistant/new", {
        method: "POST",
      });
      setThread({ conversationId, status: "idle", entries: [] });
    } catch (e) {
      setError(`could not start a new thread: ${(e as Error).message}`);
    }
  }

  /** Opening an old thread: what was read is already whatever is read aloud. */
  function openThread(opened: AssistantThread) {
    markRead(opened.entries);
    setThread(opened);
  }

  // Every turn re-sends the whole thread, so a long one gets steadily more
  // expensive to continue. Nothing truncates it automatically — dropping the
  // middle of a conversation silently is worse than saying it is getting long —
  // so this is the nudge to start a fresh one when the subject has changed.
  const turns = thread?.entries.filter((e) => e.role === "user").length ?? 0;
  /**
   * What the thread actually costs, which is not the same as how often you have
   * typed. Every reply is a model call carrying the whole conversation, and a
   * meeting is several: counting questions would put the warning well after the
   * spending it is meant to warn about.
   */
  const calls = thread?.entries.filter((e) => e.role === "assistant").length ?? 0;
  const { long, taken, carries } = threadCost(thread?.usage, calls);

  /** The header's second line: what it is doing, or how far the thread has come. */
  const lastEntry = thread?.entries.at(-1);
  const status =
    thread === null
      ? "connecting…"
      : // Said rather than hidden: while the stream is down what is on screen
        // may be a turn that has long since ended, and the only honest thing to
        // show is that nobody is listening for the end of it.
        !streaming
        ? "reconnecting…"
        : thinking
          ? thread.live
            ? "writing…"
            : thread.liveTools?.length
              ? `${thread.liveTools.at(-1)!.name}…`
              : thread.liveThinking
                ? "thinking…"
                : "starting…"
          : lastEntry
            ? `${turns} turn${turns === 1 ? "" : "s"}${calls > turns ? ` · ${calls} replies` : ""}${taken && ` · ${taken}`} · last spoke ${agoLabel(lastEntry.at)}`
            : "here";

  return (
    // The document scrolls, as it does on the other three doors. This screen
    // used to be a full-height box scrolling its own middle, and iOS treats a
    // page that cannot scroll differently: its fixed tab bar was left standing
    // above a toolbar that had already gone, and a drag at either end of the
    // thread bounced the whole page out from under that bar.
    //
    // With a panel open on a desktop, the whole screen gives up its right half
    // to it, top bar included, so the two read as one split view.
    <div
      className={`flex min-h-full flex-col pb-[calc(55px+env(safe-area-inset-bottom))] min-[800px]:pb-0 kbd:pb-0 ${
        panel ? "desk:pr-[50%]" : ""
      }`}
    >
      {/* Stuck under the top bar rather than scrolling away with the thread:
          threads and new thread are what you reach for when the subject has
          moved on, which is exactly when the thread is long enough to have
          carried them off the screen. Stuck together with the bar, in one
          wrapper, so the row does not have to know how tall the bar is.
          transform-gpu for the same iOS lag #136 fixed on the bar itself. */}
      <div className="sticky top-0 z-20 transform-gpu">
        <TopBar crumb={[{ label: "assistant" }]} />
        {/* One row: who you are talking to and whether it is doing anything,
            then the controls. It replaces a row of worded buttons and a seat
            card the size of a reply, which between them took a sixth of a
            laptop screen before anything had been said. */}
        <div className="border-b border-line-strong bg-bg/90 backdrop-blur-md">
          <div className="mx-auto flex max-w-[800px] items-center gap-2.5 px-[18px] py-2">
            <Portrait
              face={chair.face}
              colour={chair.colour}
              size={30}
              tone
              mood={thinking ? "speaking" : "idle"}
            />
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span title={chair.remit} className="truncate text-[14px] font-semibold">
                {chair.name}
              </span>
              <span
                role="status"
                className={`truncate text-[11.5px] ${thinking ? "text-accent" : "text-faint"}`}
              >
                {status}
              </span>
            </div>
            <div className="flex flex-none items-center gap-0.5">
              {canSpeak() && (
                <ToolButton
                  icon="volume"
                  on={speakReplies}
                  title={
                    speakReplies
                      ? "stop reading replies aloud"
                      : "read every reply aloud, including ones you typed"
                  }
                  onClick={toggleSpeakReplies}
                />
              )}
              {(["browser", "calendar"] as const).map((p) => (
                <ToolButton
                  key={p}
                  icon={p === "browser" ? "globe" : "calendar"}
                  on={panel === p}
                  title={
                    panel === p
                      ? `close the ${p}`
                      : p === "browser"
                        ? `${chair.name}'s own browser`
                        : "the calendar, as a month"
                  }
                  onClick={() => setPanel((v) => (v === p ? null : p))}
                />
              ))}
              <ToolButton
                icon="users"
                on={panel === "people"}
                title={panel === "people" ? "close the specialists" : "who is on the bench"}
                onClick={() => setPanel((v) => (v === "people" ? null : "people"))}
              />
              {/* Only once there is something to find: on a phone every
                  button here is taken from the chair's name. */}
              {turns > 0 && (
                <ToolButton
                  icon="search"
                  on={finding}
                  title={finding ? "close find" : "find in this thread"}
                  onClick={() => setFinding((v) => !v)}
                />
              )}
              {/* What changes the thread you are in, set apart from what only
                  changes how you see it. */}
              <span aria-hidden className="mx-1 h-5 w-px bg-line-strong" />
              <ToolButton
                icon="threads"
                title="threads: pick one up where it was left"
                onClick={() => setBrowsing(true)}
                disabled={thinking}
              />
              {turns > 0 && (
                <ToolButton
                  icon="terminal"
                  title="open this thread in a terminal, to drive it"
                  onClick={() => void openInTerminal()}
                  disabled={thinking}
                />
              )}
              {turns > 0 && (
                <ToolButton
                  icon="compose"
                  title="start a new thread"
                  onClick={() => void newThread()}
                  disabled={thinking}
                />
              )}
            </div>
          </div>
          {finding && (
            <div className="mx-auto flex max-w-[800px] items-center gap-2 px-[18px] pb-2">
              <Input
                // Opened in order to type into it, as the palette is.
                // eslint-disable-next-line jsx-a11y/no-autofocus
                autoFocus
                value={find}
                onChange={(e) => setFind(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") jump();
                  if (e.key === "Escape") setFinding(false);
                }}
                placeholder="find in this thread"
                label="find in this thread"
                className="flex-1"
              />
              {query !== "" && (
                <>
                  <span className="flex-none font-mono text-[11px] text-faint">
                    {hits === 0 ? "no matches" : `${hits} match${hits === 1 ? "" : "es"}`}
                  </span>
                  <Button onClick={jump} disabled={hits === 0} className="flex-none">
                    next
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      </div>

      <main
        ref={room}
        className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-4 px-[18px] pt-5 pb-4"
      >
        {thread === null && (
          <div className="flex flex-col gap-3">
            <Skeleton className="block h-10 w-2/5 self-end rounded-2xl bg-surface-2" />
            <Skeleton className="block h-24 w-4/5 rounded-2xl bg-surface-2" />
          </div>
        )}

        {thread && (
          <Room
            thread={thread}
            members={members}
            chair={chair}
            onRetry={retry}
            onEdit={edit}
            find={query}
          />
        )}

        {/* Sent, and not yet on record: drawn at once so the tap is seen to
            land, faint until the server has it (C-13). */}
        {sending
          // The socket can bring the question before the POST answers.
          .filter((m) => m.text !== thread?.entries.findLast((e) => e.role === "user")?.text)
          .map((m) => (
            <div
              key={m.stamp}
              className="max-w-[82%] self-end rounded-[20px] rounded-br-[6px] bg-accent-tint px-[18px] py-3 text-[15.5px] leading-[1.5] font-medium whitespace-pre-wrap text-text ring-1 ring-accent/30"
            >
              {m.text}
            </div>
          ))}

        {voiceMode && (
          <div className="flex items-center gap-2.5 rounded-xl bg-accent-tint px-3 py-2 text-[12.5px] ring-1 ring-accent/30">
            <span
              className={`h-2 w-2 flex-none rounded-full ${
                listening
                  ? "animate-pulse bg-accent"
                  : speech.error
                    ? "bg-fail"
                    : speaking
                      ? "bg-run"
                      : "bg-idle"
              }`}
            />
            <span
              role="status"
              className={`min-w-0 flex-1 truncate ${speech.error ? "text-fail" : "text-muted"}`}
            >
              {listening
                ? "listening…"
                : transcribing
                  ? "transcribing…"
                  : speaking
                    ? "speaking…"
                    : (speech.error ?? "voice mode on")}
            </span>
            {/* It stopped, and says why: the way back in is here rather than
                off and on again (C-20). */}
            {speech.error && !listening && !transcribing && (
              <button
                onClick={() => void speech.listen()}
                className="flex-none font-semibold text-accent hover:brightness-110"
              >
                listen again
              </button>
            )}
            <button onClick={toggleVoice} className="flex-none text-faint hover:text-text">
              end
            </button>
          </div>
        )}
      </main>

      {/* Stuck just clear of the bottom bar on a phone (55px is that bar's
          height), and back to its own inset where there is none. Painted with
          the page ground so the thread passing behind does not show around
          its corners. No rule above it: the field is a lifted card already,
          and a line across the page on top of that read as a second border.
          With the keyboard up the bar is hidden, so it sits on the keys. */}
      <div className="sticky bottom-[calc(55px+env(safe-area-inset-bottom))] z-10 mx-auto w-full max-w-[800px] flex-none bg-bg px-[18px] pt-2 pb-3 min-[800px]:bottom-0 min-[800px]:pb-[max(14px,env(safe-area-inset-bottom))] kbd:bottom-0 kbd:pb-2">
        {/* Gone up to read something while it keeps talking: the way back,
            rather than being dragged there by the next token. In the sticky
            card so it clears the tab bar on a phone without a second set of
            insets to keep right. */}
        {!atLatest && thread && thread.entries.length > 0 && (
          <div className="mb-2 flex justify-center">
            <button
              onClick={() => scrollTo({ top: document.documentElement.scrollHeight })}
              className="tap rounded-full border border-line bg-surface px-3 py-1 text-[11.5px] text-muted shadow-sm hover:border-accent hover:text-accent"
            >
              latest ↓
            </button>
          </div>
        )}
        {shownError && (
          <div role="alert" className="mb-2 flex items-center gap-2 text-[12.5px] text-fail">
            <span className="min-w-0 flex-1">{shownError}</span>
            <button
              type="button"
              aria-label="dismiss the error"
              onClick={() => {
                setError(null);
                speech.clearError();
              }}
              className="tap flex-none rounded-lg px-1.5 text-muted hover:text-text"
            >
              ×
            </button>
          </div>
        )}
        {/* Said where the next turn is typed, with the remedy beside it. */}
        {long && !thinking && (
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-wait/10 px-3 py-2 text-[12.5px] text-wait ring-1 ring-wait/30">
            <span className="min-w-0 flex-1">
              {carries} If the subject has moved on, start fresh.
            </span>
            <button
              onClick={() => void newThread()}
              className="flex flex-none items-center gap-1.5 rounded-lg bg-wait/15 px-2.5 py-1 font-semibold hover:brightness-110"
            >
              <Icon name="compose" size={14} />
              new thread
            </button>
          </div>
        )}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((name) => (
              <div key={name} className="relative">
                <img
                  src={`/api/assistant/uploads/${name}`}
                  alt="attached"
                  className="h-16 w-16 rounded-lg object-cover"
                />
                <button
                  onClick={() => setPending((p) => p.filter((n) => n !== name))}
                  aria-label="remove attachment"
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-surface-2 font-mono text-[11px] text-muted ring-1 ring-line hover:text-fail"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {thread?.queued && (
          <div className="mb-2 flex flex-col gap-1.5">
            {thread.queued.map((q) => (
              <div
                key={q.id}
                className="flex items-center gap-2.5 rounded-xl bg-surface px-3 py-2 text-[13px]"
              >
                <span className="flex-none text-[11.5px] text-faint">queued</span>
                <span className="min-w-0 flex-1 truncate">
                  {q.text || "(image)"}
                  {q.images.length > 0 &&
                    ` · ${q.images.length} image${q.images.length === 1 ? "" : "s"}`}
                </span>
                <button
                  onClick={() =>
                    void api(`/api/assistant/queue/${q.id}`, { method: "DELETE" }).catch(
                      (e: Error) => setError(e.message),
                    )
                  }
                  aria-label="remove from queue"
                  className="flex-none font-mono text-faint hover:text-fail"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        {/* Tonal and lifted off the page: it is the one thing here you act on. */}
        <Composer
          value={text}
          onChange={setText}
          onSend={() => void send()}
          onAttach={(files) => void attach(files)}
          onRefused={setError}
          attaching={attaching}
          canSend={(!!text.trim() && !addressOnly(text.trim())) || pending.length > 0}
          // Beside Stop mid-turn once there is something to queue, so a phone,
          // where Enter is a newline, can queue too.
          showSend={!thinking || !!text.trim() || pending.length > 0}
          sendLabel={thinking ? "queue for after this turn" : "send"}
          label="message the assistant"
          placeholder={
            listening
              ? "listening…"
              : thinking
                ? "working… anything sent now waits its turn"
                : roundTable
                  ? "round table: the specialists talk this one over"
                  : "Ask, or tell me something…"
          }
          fieldRef={grow}
          className="shadow-[0_20px_60px_light-dark(rgba(26,32,27,.14),rgba(0,0,0,.55))]"
        >
          {canSpeak() && canListen() && !thinking && (
            <button
              onClick={toggleVoice}
              aria-label={voiceMode ? "end voice mode" : "start voice mode"}
              title="hands free: it reads replies out and listens again"
              className={`tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
                voiceMode ? "bg-accent-tint text-accent" : "text-muted"
              }`}
            >
              <Ico>
                <path d="M11 5 6 9H2v6h4l5 4z" />
                <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                <path d="M18.5 5.5a9 9 0 0 1 0 13" />
              </Ico>
            </button>
          )}
          {canListen() && !thinking && !voiceMode && (
            <button
              onClick={() => (listening ? speech.stopListening() : void speech.listen())}
              aria-label={listening ? "stop dictating" : "dictate"}
              title="dictate into the field"
              className={`tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
                listening ? "animate-pulse bg-accent-tint text-accent" : "text-muted"
              }`}
            >
              <Ico>
                <rect x="9" y="2" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </Ico>
            </button>
          )}
          {thinking && (
            <button
              onClick={() => void stop()}
              className="tap-sq flex h-9 flex-none items-center gap-1.5 rounded-xl bg-surface px-3 text-[13px] font-semibold text-muted hover:text-text"
            >
              <Ico>
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </Ico>
              Stop
            </button>
          )}
        </Composer>
      </div>

      <Tabs />

      {browsing && (
        <Threads
          current={thread?.conversationId}
          onOpen={openThread}
          onNew={() => void newThread()}
          onClose={() => setBrowsing(false)}
        />
      )}

      {panel === "browser" && (
        <Dock
          title={`${chair.name}'s browser`}
          sub="live: what it opens and clicks shows up here"
          onClose={() => setPanel(null)}
        >
          <BrowserView />
        </Dock>
      )}
      {panel === "calendar" && (
        <Dock
          title="Calendar"
          sub="what it adds, moves or removes lands here"
          onClose={() => setPanel(null)}
          escape
        >
          <Month refresh={thread?.entries.length ?? 0} />
        </Dock>
      )}
      {panel === "people" && (
        <Dock
          title="Specialists"
          sub={`who ${chair.name} brings in; ask one directly`}
          onClose={() => setPanel(null)}
          escape
        >
          <People
            members={members}
            roundTable={roundTable}
            onRoundTable={setRoundTable}
            onAsk={(id) => {
              setText((t) => `@${id} ${t.replace(/^@[a-z][a-z0-9-]*\s*/i, "")}`);
              // On a phone the panel is the whole screen, and the field the
              // name just went into is under it.
              if (!matchMedia(DESK).matches) {
                setPanel(null);
              }
            }}
          />
        </Dock>
      )}
    </div>
  );
}
