import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AssistantEntry, AssistantThread } from "../../../shared/api";
import { api } from "../api";
import Raccoon, { type RaccoonMood } from "../components/Raccoon";
import TopBar from "../components/TopBar";
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
 * The assistant's chat.
 *
 * The thread arrives whole over a websocket rather than being polled or
 * diffed: it is a few kilobytes, and a diff protocol would be the only
 * stateful thing in this app. The POST that sends a turn also returns the
 * thread, so a send works even if the socket is down — the socket is what makes
 * a second device watching the same thread stay in step.
 */

function ToolChip({ name, detail }: { name: string; detail: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-2 self-start rounded-full border border-line bg-surface-2 px-2.5 py-1 font-mono text-[11px] text-muted">
      <span className="flex-none text-run">✓</span>
      <span className="truncate">
        {name}
        {detail && <span className="text-faint"> · {detail}</span>}
      </span>
    </span>
  );
}

function Turn({ entry }: { entry: AssistantEntry }) {
  if (entry.role === "user") {
    return (
      <div className="flex flex-col items-end gap-1.5">
        {entry.images?.map((name) => (
          <img
            key={name}
            src={`/api/assistant/uploads/${name}`}
            alt="attached"
            className="max-h-52 max-w-[82%] rounded-[12px] border border-line"
          />
        ))}
        {entry.text && (
          <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent px-3 py-2 text-[14px] font-medium text-on-accent">
            {entry.text}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5">
      {entry.tools.map((t, i) => (
        <ToolChip key={i} name={t.name} detail={t.detail} />
      ))}
      {entry.text && (
        <div className="flex">
          <div
            className={`max-w-[82%] rounded-[14px] rounded-bl-[5px] border px-3 py-2 text-[14px] whitespace-pre-wrap ${
              entry.failed ? "border-fail/40 bg-fail/10 text-text" : "border-line bg-surface"
            }`}
          >
            {entry.text}
          </div>
        </div>
      )}
    </div>
  );
}

export default function Assistant() {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // Hands-free: replies are read out, and the microphone reopens when the
  // reading stops, so a whole exchange happens without touching the screen.
  const [voiceMode, setVoiceMode] = useState(false);
  // Read replies out without any of the rest of it. Voice mode answers "I want
  // to talk to it"; this answers "I want to hear it", which is the case where
  // you type a question and then look away. Kept apart because the coupling was
  // the complaint: wanting to be read to meant having the microphone open.
  // Remembered per device, like the raccoon — whoever wants it wants it always.
  const [speakReplies, setSpeakReplies] = useState(
    () => localStorage.getItem("vk.assistant.speak") === "1",
  );
  // Off unless asked for, and remembered per device: it is decoration, and the
  // people who want it want it every time.
  const [showRaccoon, setShowRaccoon] = useState(
    () => localStorage.getItem("vk.assistant.raccoon") === "1",
  );
  const spokenRef = useRef<string | null>(null);

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

  // Follow the conversation as it grows, the way a chat is expected to.
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
   * Read the newest reply, then listen again. Keyed on the entry id so a
   * reconnecting socket redelivering the same thread cannot read it twice.
   */
  useEffect(() => {
    if ((!voiceMode && !speakReplies) || thinking) return;
    const last = thread?.entries.at(-1);
    if (!last || last.role !== "assistant" || !last.text) return;
    if (spokenRef.current === last.id) return;
    spokenRef.current = last.id;
    speech.speak(last.text, () => {
      // Only hands-free reopens the microphone. Reading a typed exchange aloud
      // must not start listening, or the next thing typed competes with an open
      // mic and the reply gets sent twice.
      if (voiceMode) void speech.listen();
    });
  }, [thread, voiceMode, speakReplies, thinking, speech]);

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
      spokenRef.current = thread?.entries.at(-1)?.id ?? null;
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
    spokenRef.current = thread?.entries.at(-1)?.id ?? null;
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
          body: JSON.stringify({ text: value || "(see image)", images: pending }),
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

  // Every turn re-sends the whole thread, so a long one gets steadily more
  // expensive to continue. Nothing truncates it automatically — dropping the
  // middle of a conversation silently is worse than saying it is getting long —
  // so this is the nudge to start a fresh one when the subject has changed.
  const turns = thread?.entries.filter((e) => e.role === "user").length ?? 0;
  const long = turns >= 15;

  /**
   * The mouth moves when there are words, and only then: while it is writing
   * them, or while they are being read aloud. Thinking is not talking.
   *
   * An earlier version flapped for the whole turn, on the theory that the mouth
   * stopping between the last token and the end of the turn would read as a
   * stutter. It does not — thinking and idle draw the same gentle sway, so
   * there was nothing to smooth over, and flapping before it had said anything
   * just looked like it was chewing.
   */
  const mood: RaccoonMood = listening
    ? "listening"
    : speaking || thread?.live
      ? "speaking"
      : thinking || transcribing
        ? "thinking"
        : "idle";

  return (
    <div className="flex h-full flex-col">
      <TopBar crumb={["assistant"]} back="/" />

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pt-4 pb-3">
        {showRaccoon && (
          <div className="flex flex-none justify-center pt-1 pb-2">
            <Raccoon mood={mood} className="w-[170px]" />
          </div>
        )}

        {/* Always present: the raccoon toggle lives here, and gating the whole
            row on having turns meant it did not exist on a fresh thread. */}
        {/* The count reads left, the controls sit together on the right. They
            used to run on from the count as one ragged line, which made three
            mode toggles look like part of the sentence. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-[12px] text-faint">
          {turns > 0 && (
            <span className={long ? "text-wait" : undefined}>
              {turns} turn{turns === 1 ? "" : "s"}
              {long && " · getting expensive to continue"}
            </span>
          )}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <button
              onClick={() => {
                const next = !showRaccoon;
                setShowRaccoon(next);
                localStorage.setItem("vk.assistant.raccoon", next ? "1" : "0");
              }}
              title={showRaccoon ? "hide the raccoon" : "show the raccoon"}
              aria-pressed={showRaccoon}
              className={`rounded-md border px-2 py-1 font-medium hover:border-line-strong hover:text-text ${
                showRaccoon ? "border-accent/50 text-accent" : "border-line text-muted"
              }`}
            >
              raccoon
            </button>
            {canSpeak() && (
              <button
                onClick={toggleSpeakReplies}
                title={
                  speakReplies
                    ? "stop reading replies aloud"
                    : "read every reply aloud, including ones you typed"
                }
                aria-pressed={speakReplies}
                className={`rounded-md border px-2 py-1 font-medium hover:border-line-strong hover:text-text ${
                  speakReplies ? "border-accent/50 text-accent" : "border-line text-muted"
                }`}
              >
                read aloud
              </button>
            )}
            {turns > 0 && (
              <button
                onClick={() => void newThread()}
                disabled={thinking}
                className={`rounded-md border px-2 py-1 font-medium hover:border-line-strong hover:text-text disabled:opacity-40 ${
                  long ? "border-wait/50 text-wait" : "border-line text-muted"
                }`}
              >
                new thread
              </button>
            )}
          </span>
        </div>

        {thread === null && <div className="text-sm text-muted">connecting…</div>}

        {thread?.entries.length === 0 && (
          <div className="mt-6 text-center">
            <div className="font-mono text-[13px] text-muted">nothing said yet</div>
            <p className="mx-auto mt-2 max-w-[42ch] text-[13.5px] text-faint">
              Ask what needs you, or tell it something to remember. It can read your projects,
              sessions and runs.
            </p>
          </div>
        )}

        {thread?.entries.map((e) => (
          <Turn key={e.id} entry={e} />
        ))}

        {/* The sentence being written. Replaced by the stored entry the moment
            the model finishes it, so it never appears twice. */}
        {thread?.live && (
          <div className="flex">
            <div className="max-w-[82%] rounded-[14px] rounded-bl-[5px] border border-line bg-surface px-3 py-2 text-[14px] whitespace-pre-wrap">
              {thread.live}
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-blink bg-accent align-[-2px]" />
            </div>
          </div>
        )}

        {voiceMode && (
          <div className="flex items-center gap-2.5 rounded-[11px] border border-accent/40 bg-accent/[.06] px-3 py-2 font-mono text-[12px]">
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

        {thinking && !thread?.live && (
          <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
            thinking…
          </div>
        )}

        <div ref={endRef} />
      </main>

      <div className="mx-auto w-full max-w-[760px] flex-none px-[18px] pb-[max(14px,env(safe-area-inset-bottom))]">
        {error && <div className="mb-2 font-mono text-[12px] text-fail">{error}</div>}
        {pending.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pending.map((name) => (
              <div key={name} className="relative">
                <img
                  src={`/api/assistant/uploads/${name}`}
                  alt="attached"
                  className="h-16 w-16 rounded-lg border border-line object-cover"
                />
                <button
                  onClick={() => setPending((p) => p.filter((n) => n !== name))}
                  aria-label="remove attachment"
                  className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full border border-line bg-surface-2 font-mono text-[11px] text-muted hover:text-fail"
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
        {/* Field on top, controls on their own row underneath. In one row the
            four buttons crowded the field from both sides and the send button
            drifted with the field's width; here each control has a fixed home
            and the field gets the full width at any size. */}
        <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
          <textarea
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
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={thinking}
              aria-label="attach an image"
              className="tap-sq flex flex-none items-center justify-center rounded-lg border border-line px-2.5 py-2 text-muted hover:border-line-strong hover:text-text disabled:opacity-40"
            >
              <Ico>
                <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </Ico>
            </button>
            <span className="flex-1" />
            {canSpeak() && canListen() && !thinking && (
              <button
                onClick={toggleVoice}
                aria-label={voiceMode ? "end voice mode" : "start voice mode"}
                title="hands free: it reads replies out and listens again"
                className={`tap-sq flex flex-none items-center justify-center rounded-lg border px-2.5 py-2 hover:border-line-strong ${
                  voiceMode ? "border-accent bg-accent-tint text-accent" : "border-line text-muted"
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
                className={`tap-sq flex flex-none items-center justify-center rounded-lg border px-2.5 py-2 hover:border-line-strong ${
                  listening
                    ? "animate-pulse border-accent bg-accent-tint text-accent"
                    : "border-line text-muted"
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
                className="tap-sq flex flex-none items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[13px] font-semibold text-muted hover:border-line-strong hover:text-text"
              >
                <Ico>
                  <rect x="7" y="7" width="10" height="10" rx="2" />
                </Ico>
                Stop
              </button>
            ) : (
              // A filled circle rather than a rounded rectangle: it is the one
              // action in this row that commits something, and at four buttons
              // wide the outlined ones stopped reading as a set with it.
              <button
                onClick={() => void send()}
                disabled={!text.trim() && !pending.length}
                aria-label="send"
                className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface-2 disabled:text-faint"
              >
                <Ico>
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </Ico>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
