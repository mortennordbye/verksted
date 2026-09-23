import { useEffect, useRef, useState } from "react";
import type { SessionPrompt, TuiPrompt } from "../../shared/api";
import { api } from "./api";
import { unchanged } from "./useSessionChat";

const POLL_MS = 3_000;

/**
 * The pane, scraped: what dialog it is drawing, and which mode it is in.
 *
 * The one thing on the session chat that does not come from the transcript,
 * and it is deliberately its own request rather than part of `/chat` — that
 * endpoint is a file read and cannot drift from what happened, and folding a
 * scrape into it would make the whole conversation only as trustworthy as the
 * scrape. See the route's own note.
 *
 * Both readings come off one capture. Polled whenever the session is live,
 * because the mode is worth knowing at any moment, one request at a time for
 * the same reason the transcript is (C-25). `look` is for a tap that changed
 * the pane: waiting seconds to find out whether it registered is how people
 * end up tapping twice, which on a toggle undoes what they did.
 */
export function usePanePrompt(sessionId: string, live: boolean) {
  const [prompt, setPrompt] = useState<TuiPrompt | null>(null);
  const [mode, setMode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [doing, setDoing] = useState<string | null>(null);
  const lookNow = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    if (!live) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    async function read() {
      try {
        const res = await api<SessionPrompt>(`/api/sessions/${sessionId}/prompt`);
        if (stopped) return;
        // A dialog nobody has touched is a new object on every capture, and it
        // is drawn above the conversation.
        setPrompt((prev) => (unchanged(prev, res.prompt) ? prev : res.prompt));
        setMode(res.mode);
        setBusy(res.busy);
        setDoing(res.doing);
      } catch {
        // A pane that cannot be read is not a pane that is asking anything.
        if (!stopped) {
          setPrompt(null);
          setMode(null);
          setBusy(false);
          setDoing(null);
        }
      }
    }

    const look = (): Promise<void> => {
      if (stopped) return Promise.resolve();
      // A tap mid-read wants the pane as it is after the tap, not the answer
      // already on its way: one more read, once that one is back.
      if (inFlight) return inFlight.then(look);
      if (timer) clearTimeout(timer);
      timer = null;
      inFlight = (document.hidden ? Promise.resolve() : read()).finally(() => {
        inFlight = null;
        if (!stopped) timer = setTimeout(() => void look(), POLL_MS);
      });
      return inFlight;
    };

    const onVisible = () => {
      if (!document.hidden) void look();
    };
    void look();
    lookNow.current = look;
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      lookNow.current = null;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      // What the pane said stops being true once nothing is reading it: a
      // session that ended, or another session's pane.
      setPrompt(null);
      setMode(null);
      setBusy(false);
      setDoing(null);
    };
  }, [sessionId, live]);

  return { prompt, mode, busy, doing, look: () => lookNow.current?.() ?? Promise.resolve() };
}
