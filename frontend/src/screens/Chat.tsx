import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantThread, AssistantThreadSummary, CouncilMember } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import Room from "../components/Room";
import Sheet from "../components/Sheet";
import TopBar from "../components/TopBar";
import { useGrow } from "../useGrow";
import { canListen, canSpeak, unlockAudio, useSpeech } from "../useSpeech";

/**
 * The composer's icons, drawn rather than typed.
 *
 * These were the glyphs "+", "((•))", "●" and "↑". No mono font ships the last
 * three, so each came from whatever fallback the platform picked and they
 * landed at different weights and sizes in a row four buttons wide — the same
 * fault the top bar's two icons had before they were drawn.
 */
function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/**
 * The conversation, and the only room there is.
 *
 * One thread, whoever answers in it: the assistant alone, or a specialist it
 * brings in, whose answer lands as a card in their own colour. The council
 * was a second screen with a thread of its own; that made the person route
 * every question before asking it, so it is gone, and what it was for happens
 * here without being asked for. Addressing one of them by name is still
 * possible — the chips under the field write the `@id` the server reads — but
 * it is a shortcut past a decision that is made for you, not one you have to
 * make.
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
 * Every conversation this room has had, and the way back into one.
 *
 * Fetched when opened rather than polled: the list changes when a thread is
 * started, which is something you did a moment ago on this same screen.
 */
function Threads({
  current,
  onOpen,
  onClose,
}: {
  current: string | undefined;
  onOpen: (thread: AssistantThread) => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<AssistantThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AssistantThreadSummary[]>("/api/assistant/threads")
      .then(setThreads)
      .catch((e: Error) => setError(e.message));
  }, []);

  async function open(id: string) {
    try {
      onOpen(
        await api<AssistantThread>(`/api/assistant/threads/${id}/open`, {
          method: "POST",
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <Sheet title="Threads" sub="Pick one up where it was left." onClose={onClose}>
      {error && <div className="mb-2 font-mono text-[12px] text-fail">{error}</div>}
      {threads === null && !error && <div className="text-sm text-muted">reading…</div>}
      {threads?.length === 0 && <div className="text-sm text-muted">nothing said in here yet</div>}
      <div className="flex flex-col gap-1.5">
        {threads?.map((t) => {
          const here = t.conversationId === current;
          return (
            <button
              key={t.conversationId}
              type="button"
              onClick={() => void open(t.conversationId)}
              disabled={here}
              className={`tap flex flex-col items-start gap-0.5 rounded-xl px-3 py-2 text-left hover:bg-surface-2 disabled:cursor-default ${
                here ? "bg-accent-tint ring-1 ring-accent/30" : "bg-surface-2/60"
              }`}
            >
              <span className="w-full truncate text-[13.5px]">{t.title}</span>
              <span className="font-mono text-[11px] text-faint">
                {here ? "open now" : agoLabel(t.at)} · {t.turns} turn{t.turns === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}

/** A toolbar toggle: two states, remembered or not, and never the main event. */
function Toggle({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-md px-1.5 py-1 font-medium hover:text-text ${
        on ? "text-accent" : "text-faint"
      }`}
    >
      {children}
    </button>
  );
}

/** One of the composer's audience chips: who hears the next question. */
function Chip({
  on,
  title,
  onClick,
  children,
}: {
  on: boolean;
  title: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      className={`rounded-lg px-2.5 py-1.5 text-[12.5px] font-semibold whitespace-nowrap transition-colors ${
        on ? "bg-line-strong text-text" : "text-muted hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

export default function Chat() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [text, setText] = useState("");
  const grow = useGrow(text);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Hands-free: replies are read out, and the microphone reopens when the
  // reading stops, so a whole exchange happens without touching the screen.
  const [voiceMode, setVoiceMode] = useState(false);
  // Read replies out without any of the rest of it. Voice mode answers "I want
  // to talk to it"; this answers "I want to hear it", which is the case where
  // you type a question and then look away. Kept apart because the coupling was
  // the complaint: wanting to be read to meant having the microphone open.
  // Remembered per device: whoever wants it wants it always.
  const [speakReplies, setSpeakReplies] = useState(
    () => localStorage.getItem("vk.assistant.speak") === "1",
  );
  /**
   * Ask the council to talk this one over instead of answering in parallel.
   *
   * Not remembered across reloads, unlike the two above: it is the one switch
   * here that costs real money every time it is on — the advisors answer one
   * after another, each carrying what the others said — so it should not
   * survive a session you have forgotten you started.
   */
  const [roundTable, setRoundTable] = useState(false);
  /**
   * Entries already read out. A set rather than one id, because a meeting lands
   * several at once and "the last one" would silently drop the rest.
   */
  const spokenRef = useRef<Set<string>>(new Set());
  // The roster changes when somebody edits it in settings, which is rarely, so
  // it is polled slowly rather than pushed: the seat at the top is the chair's,
  // and a specialist's card is drawn in its own colour when one answers.
  const { data: roster } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const members = roster ?? [];
  const byId = new Map(members.map((m) => [m.id, m]));
  const chair = members.find((m) => m.chair) ?? NO_CHAIR;
  const advisors = members.filter((m) => !m.chair);

  // One socket for the life of the screen. It only ever carries whole threads,
  // so a dropped frame costs nothing: the next one is complete.
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/assistant/stream`);
    ws.onmessage = (e: MessageEvent<string>) => {
      try {
        setThread(JSON.parse(e.data) as AssistantThread);
      } catch {
        // A frame we cannot read is not worth taking the screen down for.
      }
    };
    // The socket sends the thread on connect, so there is no separate fetch.
    return () => ws.close();
  }, []);

  // Follow the conversation as it grows, the way a conversation is expected
  // to: an answer landing under the question is worth scrolling to.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [thread?.entries.length, thread?.status, thread?.live]);

  const thinking = thread?.status === "thinking";

  /** Upload first, then send names: the server owns where an image lands. */
  async function attach(files: FileList | File[]) {
    const ok = ["png", "jpg", "jpeg", "gif", "webp"];
    for (const file of Array.from(files).slice(0, 4)) {
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
  }

  const speech = useSpeech((said) => void send(said));
  const { listening, speaking, transcribing } = speech;

  /**
   * Read what has not been read yet, in order, each in its speaker's voice.
   *
   * A meeting produces several replies at once, so this is a queue rather than
   * "the last one". Reading them all only became the right answer once each
   * advisor had a voice of its own: in one voice it is four answers that sound
   * like one person changing their mind, which is why it used to read the
   * chair's summary alone.
   *
   * Keyed on entry ids already spoken, so a reconnecting socket redelivering
   * the whole thread cannot read anything twice.
   */
  useEffect(() => {
    if ((!voiceMode && !speakReplies) || thinking) return;
    const pending = (thread?.entries ?? []).filter(
      (e) => e.role === "assistant" && e.text && !spokenRef.current.has(e.id),
    );
    if (!pending.length) return;
    for (const e of pending) spokenRef.current.add(e.id);

    const readFrom = (i: number) => {
      const entry = pending[i];
      if (!entry) {
        // Only hands-free reopens the microphone. Reading a typed exchange
        // aloud must not start listening, or the next thing typed competes
        // with an open mic and the reply gets sent twice.
        if (voiceMode) void speech.listen();
        return;
      }
      const who = entry.member ? byId.get(entry.member) : undefined;
      speech.speak(entry.text, () => readFrom(i + 1), who?.voice || undefined);
    };
    readFrom(0);
  }, [thread, voiceMode, speakReplies, thinking, speech, byId]);

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
    localStorage.setItem("vk.assistant.speak", next ? "1" : "0");
    if (next) {
      // Whatever is already on screen has been read, or was never meant to be.
      for (const e of thread?.entries ?? []) spokenRef.current.add(e.id);
      // This tap is the user gesture iOS wants before any audio may play
      // without one — for the pod's voice as much as the browser's, since a
      // reply arrives long after any tap.
      unlockAudio();
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
    for (const e of thread?.entries ?? []) spokenRef.current.add(e.id);
    void speech.listen();
  }

  async function send(spoken?: string) {
    const value = (spoken ?? text).trim();
    if ((!value && !pending.length) || thinking) return;
    if (!spoken) setText("");
    setError(null);
    try {
      setThread(
        await api<AssistantThread>("/api/assistant/messages", {
          method: "POST",
          body: JSON.stringify({
            text: value || "(see image)",
            images: pending,
            roundTable,
          }),
          // A turn does real work; the default 15s would abandon every one of
          // them while the socket kept showing it running.
          timeoutMs: 11 * 60_000,
        }),
      );
      setPending([]);
    } catch (e) {
      setError((e as Error).message);
      if (!spoken) setText(value);
    }
  }

  async function stop() {
    await api("/api/assistant/stop", { method: "POST" }).catch(() => {});
  }

  async function newThread() {
    setThread(null);
    await api("/api/assistant/new", { method: "POST" }).catch(() => {});
  }

  /** Opening an old thread: what was read is already whatever is read aloud. */
  function openThread(opened: AssistantThread) {
    for (const e of opened.entries) spokenRef.current.add(e.id);
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
  const long = calls >= 15;

  /**
   * Who the next question goes to, read off the front of the field: `@id`
   * names one advisor, `@all` the room, nothing the chair. The seats and the
   * chips below both write it there, so the field is the one source of truth
   * and what is sent is exactly what is shown.
   */
  const addressed = /^@([a-z][a-z0-9-]*)/.exec(text.trim())?.[1] ?? null;
  function address(id: string | null) {
    const stripped = text.replace(/^@[a-z][a-z0-9-]*\s*/, "");
    setText(id === null || id === "chair" ? stripped : `@${id} ${stripped}`);
  }
  const named = addressed && addressed !== "all" ? byId.get(addressed) : undefined;

  return (
    <div className="flex h-full flex-col">
      <TopBar crumb={[{ label: "assistant" }]} back="/" />

      <main className="mx-auto flex w-full max-w-[800px] flex-1 flex-col gap-4 overflow-y-auto px-[18px] pt-4 pb-3">
        {/* The count reads left, the controls sit together on the right. The
            switch is a plain word; the two that change which thread you are in
            are the lifted ones. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-faint">
          {turns > 0 && (
            <span>
              {turns} turn{turns === 1 ? "" : "s"}
              {calls > turns && ` · ${calls} replies`}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {canSpeak() && (
              <Toggle
                on={speakReplies}
                title={
                  speakReplies
                    ? "stop reading replies aloud"
                    : "read every reply aloud, including ones you typed"
                }
                onClick={toggleSpeakReplies}
              >
                read aloud
              </Toggle>
            )}
            <button
              onClick={() => setBrowsing(true)}
              disabled={thinking}
              className="ml-1 rounded-lg bg-surface px-2.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
            >
              threads
            </button>
            {turns > 0 && (
              <button
                onClick={() => void newThread()}
                disabled={thinking}
                className="rounded-lg bg-surface px-2.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-text disabled:opacity-40"
              >
                new thread
              </button>
            )}
          </span>
        </div>

        {thread === null && <div className="text-sm text-muted">connecting…</div>}

        {thread && <Room thread={thread} members={members} chair={chair} />}

        {voiceMode && (
          <div className="flex items-center gap-2.5 rounded-xl bg-accent-tint px-3 py-2 font-mono text-[12px] ring-1 ring-accent/30">
            <span
              className={`h-2 w-2 flex-none rounded-full ${
                listening ? "animate-pulse bg-accent" : speaking ? "bg-run" : "bg-idle"
              }`}
            />
            <span className="min-w-0 flex-1 truncate text-muted">
              {listening
                ? "listening…"
                : transcribing
                  ? "transcribing…"
                  : speaking
                    ? "speaking…"
                    : "voice mode on"}
            </span>
            <button onClick={toggleVoice} className="flex-none text-faint hover:text-text">
              end
            </button>
          </div>
        )}

        <div ref={endRef} />
      </main>

      <div className="mx-auto w-full max-w-[800px] flex-none px-[18px] pb-[max(14px,env(safe-area-inset-bottom))]">
        {error && <div className="mb-2 font-mono text-[12px] text-fail">{error}</div>}
        {/* Said where the next turn is typed, with the remedy beside it. */}
        {long && !thinking && (
          <div className="mb-2 flex items-center gap-3 rounded-xl bg-wait/10 px-3 py-2 text-[12.5px] text-wait ring-1 ring-wait/30">
            <span className="min-w-0 flex-1">
              {calls} replies in this thread, and every new one carries all of them. If the subject
              has moved on, start fresh.
            </span>
            <button
              onClick={() => void newThread()}
              className="flex-none rounded-lg bg-wait/15 px-2.5 py-1 font-semibold hover:brightness-110"
            >
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
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void attach(e.target.files);
            e.target.value = "";
          }}
        />

        {/* Tonal and lifted off the page: it is the one thing here you act on.
            Field on top, controls underneath; the audience sits in the same
            row as the send button, since who hears it and sending it are one
            decision. */}
        <div className="rounded-3xl bg-surface-2 px-4 pt-3.5 pb-3 shadow-[0_20px_60px_rgba(0,0,0,.55)]">
          <textarea
            ref={grow}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, shift+enter breaks the line. On a phone the key is
              // a newline either way, which is why the button is always there.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            onPaste={(e) => {
              // A screenshot pasted from the clipboard is the desktop half of
              // the attach button.
              const files = Array.from(e.clipboardData.files);
              if (files.length) {
                e.preventDefault();
                void attach(files);
              }
            }}
            rows={1}
            placeholder={
              listening ? "listening…" : thinking ? "working…" : "Ask, or tell me something…"
            }
            aria-label="message the assistant"
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent px-1 text-[16px] outline-none placeholder:text-faint"
          />
          {/* On a phone the audience takes a row of its own above the buttons,
              since four buttons and three chips do not share 350px. */}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={thinking}
              aria-label="attach an image"
              className="tap-sq order-2 flex h-9 w-9 flex-none items-center justify-center rounded-xl text-muted hover:bg-line-strong/40 hover:text-text disabled:opacity-40 min-[620px]:order-1"
            >
              <Ico>
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Ico>
            </button>

            {/* Who hears it. The chair decides by default and hands the
                question on itself; these are the shortcut for when you already
                know whose it is, not a routing decision you have to make. */}
            {advisors.length > 0 && (
              <div className="order-1 flex min-w-0 basis-full items-center gap-0.5 overflow-x-auto rounded-xl bg-surface p-0.5 min-[620px]:order-2 min-[620px]:basis-auto">
                {named ? (
                  <Chip
                    on
                    title="asking this one alone; tap to ask the chair instead"
                    onClick={() => address(null)}
                  >
                    to {named.name} ×
                  </Chip>
                ) : (
                  <>
                    <Chip
                      on={!addressed}
                      title="the chair answers, or hands it to whoever it belongs to"
                      onClick={() => address(null)}
                    >
                      {chair.name} decides
                    </Chip>
                    {advisors.length > 1 && (
                      <Chip
                        on={addressed === "all"}
                        title="put it to the whole room: everybody answers"
                        onClick={() => address(addressed === "all" ? null : "all")}
                      >
                        everyone
                      </Chip>
                    )}
                  </>
                )}
                {advisors.length > 1 && (
                  <Chip
                    on={roundTable}
                    title={
                      roundTable
                        ? "back to one answer each, in parallel"
                        : "have them talk it over: each one answers having read the others"
                    }
                    onClick={() => setRoundTable((r) => !r)}
                  >
                    talk it over
                  </Chip>
                )}
              </div>
            )}

            <span className="order-3 flex-1" />
            {canSpeak() && canListen() && !thinking && (
              <button
                onClick={toggleVoice}
                aria-label={voiceMode ? "end voice mode" : "start voice mode"}
                title="hands free: it reads replies out and listens again"
                className={`tap-sq order-4 flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
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
                className={`tap-sq order-4 flex h-9 w-9 flex-none items-center justify-center rounded-xl hover:bg-line-strong/40 ${
                  listening ? "animate-pulse bg-accent-tint text-accent" : "text-muted"
                }`}
              >
                <Ico>
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
                </Ico>
              </button>
            )}
            {thinking ? (
              <button
                onClick={() => void stop()}
                className="tap-sq order-4 flex h-9 flex-none items-center gap-1.5 rounded-xl bg-surface px-3 text-[13px] font-semibold text-muted hover:text-text"
              >
                <Ico>
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </Ico>
                Stop
              </button>
            ) : (
              // A filled circle: it is the one action in this row that commits
              // something.
              <button
                onClick={() => void send()}
                disabled={!text.trim() && !pending.length}
                aria-label="send"
                className="tap-sq order-4 flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface disabled:text-faint"
              >
                <Ico>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </Ico>
              </button>
            )}
          </div>
        </div>
      </div>

      {browsing && (
        <Threads
          current={thread?.conversationId}
          onOpen={openThread}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
