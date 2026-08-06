import { useEffect, useRef, useState } from "react";
import type { AssistantEntry, AssistantThread } from "../../../shared/api";
import { api } from "../api";
import TopBar from "../components/TopBar";

/**
 * The assistant's chat.
 *
 * The thread arrives whole over a websocket rather than being polled or
 * diffed: it is a few kilobytes, and a diff protocol would be the only
 * stateful thing in this app. The POST that sends a turn also returns the
 * thread, so a send works even if the socket is down — the socket is what makes
 * a second device watching the same thread stay in step.
 */

/**
 * The slice of the Web Speech API this uses. Typed here rather than pulled from
 * lib.dom: it is still vendor-prefixed in the browsers that have it, and absent
 * in the ones that do not, so the feature test below is the real contract.
 */
interface SpeechEvent {
  results: { [i: number]: { [j: number]: { transcript: string } }; length: number };
}
interface SpeechRecognitionLike {
  interimResults: boolean;
  continuous: boolean;
  onresult: (e: SpeechEvent) => void;
  onend: () => void;
  onerror: () => void;
  start: () => void;
  stop: () => void;
}

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
  const [listening, setListening] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [canDictate] = useState(
    () =>
      typeof window !== "undefined" &&
      ("SpeechRecognition" in window || "webkitSpeechRecognition" in window),
  );

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
  }, [thread?.entries.length, thread?.status]);

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

  /**
   * Dictation through the browser's own recogniser. Not every browser has it —
   * iOS gives you the keyboard's mic button instead, which types into the field
   * exactly the same way — so the button only appears where it will work.
   */
  function dictate() {
    const Recognition =
      (window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike })
        .SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: new () => SpeechRecognitionLike })
        .webkitSpeechRecognition;
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.interimResults = true;
    recognition.continuous = true;
    const before = text ? `${text} ` : "";
    recognition.onresult = (e: SpeechEvent) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i][0].transcript;
      setText(before + said);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = () => setListening(false);
    recognition.start();
    setListening(true);
    recognitionRef.current = recognition;
  }

  async function send() {
    const value = text.trim();
    if ((!value && !pending.length) || thinking) return;
    setText("");
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
      setText(value);
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

  return (
    <div className="flex h-full flex-col">
      <TopBar crumb={["assistant"]} back="/" />

      <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col gap-3.5 overflow-y-auto px-[18px] pt-4 pb-3">
        {turns > 0 && (
          <div className="flex items-center gap-3 font-mono text-[11px] text-faint">
            <span>
              {turns} turn{turns === 1 ? "" : "s"}
              {long && " · getting expensive to continue"}
            </span>
            <button
              onClick={() => void newThread()}
              disabled={thinking}
              className={`rounded-[7px] border px-2 py-0.5 hover:border-faint hover:text-text disabled:opacity-40 ${
                long ? "border-wait/50 text-wait" : "border-line text-muted"
              }`}
            >
              new thread
            </button>
          </div>
        )}

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

        {thinking && (
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
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={thinking}
            aria-label="attach an image"
            className="tap-sq flex-none rounded-lg border border-line px-2.5 py-1.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-40"
          >
            +
          </button>
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
            className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          {canDictate && !thinking && (
            <button
              onClick={() => {
                if (listening) recognitionRef.current?.stop();
                else dictate();
              }}
              aria-label={listening ? "stop dictating" : "dictate"}
              className={`tap-sq flex-none rounded-lg border px-2.5 py-1.5 font-mono text-[13px] hover:border-faint disabled:opacity-40 ${
                listening ? "animate-pulse border-accent text-accent" : "border-line text-muted"
              }`}
            >
              ●
            </button>
          )}
          {thinking ? (
            <button
              onClick={() => void stop()}
              className="tap-sq flex-none rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] font-semibold text-muted hover:border-faint hover:text-text"
            >
              stop
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!text.trim() && !pending.length}
              aria-label="send"
              className="tap-sq flex-none rounded-lg bg-accent px-3 py-1.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-40"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
