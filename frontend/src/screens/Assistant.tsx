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
      <div className="flex justify-end">
        <div className="max-w-[82%] rounded-[14px] rounded-br-[5px] bg-accent px-3 py-2 text-[14px] font-medium text-on-accent">
          {entry.text}
        </div>
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
  const endRef = useRef<HTMLDivElement | null>(null);

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

  async function send() {
    const value = text.trim();
    if (!value || thinking) return;
    setText("");
    setError(null);
    try {
      setThread(
        await api<AssistantThread>("/api/assistant/messages", {
          method: "POST",
          body: JSON.stringify({ text: value }),
          // A turn does real work; the default 15s would abandon every one of
          // them while the socket kept showing it running.
          timeoutMs: 11 * 60_000,
        }),
      );
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
        <div className="flex items-end gap-2 rounded-xl border border-line bg-surface px-3 py-2">
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
            rows={1}
            placeholder={thinking ? "working…" : "Ask, or tell me something to remember…"}
            aria-label="message the assistant"
            className="max-h-32 min-h-[24px] flex-1 resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
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
              disabled={!text.trim()}
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
