import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AssistantFrame, AssistantThread } from "../../shared/api";
import { api } from "./api";

/** 1s, 2s, 4s, 8s, then every 16. */
const MAX_BACKOFF_MS = 16_000;
/** How often the thread is fetched outright while there is no socket. */
const FALLBACK_MS = 5_000;

/**
 * Which thread to show when a POST answers: the one held, or the one it sent.
 *
 * The POST answers as soon as the question is recorded, and the socket is a
 * second connection with no ordering against the first. On a slow tunnel the
 * answer can land after frames that are already past it, and it says
 * "thinking": put over a thread whose turn has ended, nothing would ever
 * arrive to correct it, and the composer would queue behind it until a reload.
 */
export function adopt(held: AssistantThread | null, accepted: AssistantThread): AssistantThread {
  return held?.conversationId === accepted.conversationId &&
    held.entries.length >= accepted.entries.length
    ? held
    : accepted;
}

/**
 * The assistant thread, kept live.
 *
 * Its own file rather than an effect inside the screen because this is the
 * part of the chat that can be got wrong without anything on screen saying so,
 * and the only way to pin it is to drive it: a socket that closes mid-turn, a
 * tab that comes back after an hour, a first connect that never lands. The
 * screen renders what this returns and has no opinion about transport.
 *
 * The socket carries whole threads, so a dropped frame costs nothing — the
 * next one is complete. A dropped socket used to cost everything. This is read
 * on a phone, and a phone sleeps: the connection died with the last frame
 * saying "thinking", the composer queues everything typed while thinking, and
 * the drain waits on a thread that was never coming. It said "working…" until
 * a reload, and a first connect that failed said "connecting…" for as long as
 * the screen stayed open.
 */
export function useAssistantStream(): {
  thread: AssistantThread | null;
  /**
   * For the callers that hold a thread of their own: a POST's answer, an opened
   * one. A function of the thread held, because a POST's answer can arrive
   * after a frame that is already ahead of it.
   */
  setThread: Dispatch<SetStateAction<AssistantThread | null>>;
  /** False while there is no socket, which is what the header says out loud. */
  streaming: boolean;
} {
  const [thread, setThread] = useState<AssistantThread | null>(null);
  const [streaming, setStreaming] = useState(false);
  // The fallback below must not fire into a screen that has gone.
  const alive = useRef(true);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let gone = false;
    alive.current = true;

    const retry = () => {
      if (gone || timer) return;
      // A deploy is back inside the first few tries; a phone in a pocket out of
      // WireGuard range must not spend its battery asking every second until it
      // is picked up again.
      const wait = Math.min(1000 * 2 ** attempt++, MAX_BACKOFF_MS);
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, wait);
    };

    const connect = () => {
      if (gone) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/assistant/stream`);
      ws.onopen = () => {
        attempt = 0;
        setStreaming(true);
      };
      ws.onmessage = (e: MessageEvent<string>) => {
        try {
          const frame = JSON.parse(e.data) as AssistantFrame;
          setThread((prev) => {
            // No entries means nothing has been said since the last frame, so
            // the ones already held are still the ones — kept by reference, so
            // nothing on screen re-parses its markdown for a frame that only
            // moved `live` on by a token.
            if (frame.entries) return frame as AssistantThread;
            if (!prev) return null;
            return { ...frame, entries: prev.entries };
          });
        } catch {
          // A frame we cannot read is not worth taking the screen down for.
        }
      };
      // Not `onerror`: a failed connect fires both, and a close always follows.
      ws.onclose = () => {
        setStreaming(false);
        retry();
      };
    };

    /**
     * Picked back up: try again now rather than at the end of a backoff that
     * grew while the screen was dark. iOS suspends the tab rather than closing
     * the socket, so the close often arrives here, on the way back in.
     */
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING))
        return;
      if (timer) clearTimeout(timer);
      timer = null;
      attempt = 0;
      connect();
    };

    // The socket sends the thread on connect, so there is no separate fetch.
    connect();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      gone = true;
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer) clearTimeout(timer);
      // The close handler would otherwise schedule a reconnect on the way out.
      if (ws) ws.onclose = null;
      ws?.close();
    };
  }, []);

  /**
   * What the socket would have been saying.
   *
   * While the stream is down the screen has no way to learn that the turn it is
   * waiting on has ended, and that is precisely the state that strands the send
   * queue. Slower than the socket by a long way, and only while there is no
   * socket: this is the floor, not the transport.
   */
  useEffect(() => {
    if (streaming) return;
    const id = setInterval(() => {
      api<AssistantThread>("/api/assistant")
        .then((t) => {
          if (alive.current) setThread(t);
        })
        .catch(() => {
          // Reachability is `api`'s business, and the reconnect above is the retry.
        });
    }, FALLBACK_MS);
    return () => clearInterval(id);
  }, [streaming]);

  return { thread, setThread, streaming };
}
