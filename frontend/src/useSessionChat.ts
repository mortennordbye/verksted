import { useEffect, useRef, useState } from "react";
import type { ChatMessage, ChatTodo, ChatToolCall, SessionChat } from "../../shared/api";
import { api } from "./api";

/** A message sent from here that the transcript has not echoed back yet. */
export interface Echo {
  text: string;
  at: number;
}

/** How long an unmatched echo stays on screen before it is assumed swallowed. */
const ECHO_TTL_MS = 90_000;

/** Tail of the transcript to ask for; "load earlier" widens it. Matches the
    backend's default, and its ceiling. */
const WINDOW = 256_000;
const MAX_WINDOW = 8_000_000;

/**
 * Whether a poll's answer says what is already held.
 *
 * For the small fixed-shape things that arrive on every poll whether or not
 * they have changed — the checklist, the calls in flight, the dialog. They are
 * a handful of small objects, so this costs nothing next to what it saves:
 * handing React a new array every three seconds re-renders everything built
 * from it, and one of them is watched by the effect that decides where the
 * conversation is scrolled to.
 */
export function unchanged(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Whether two readings of the same message say the same thing.
 *
 * Cheap on purpose, and deliberately not a deep compare: this runs over every
 * held message every three seconds, and what it guards is object identity. A
 * message that has not changed must come back as the *same object*, or every
 * bubble in the conversation re-parses its markdown on every poll.
 *
 * What can actually change after a message is first written is a card closing
 * and a turn growing another tool chip. Text is immutable once the entry is in
 * the transcript.
 */
function same(a: ChatMessage, b: ChatMessage): boolean {
  return (
    a.text === b.text &&
    a.tools.length === b.tools.length &&
    a.ask?.answered === b.ask?.answered &&
    a.plan?.approved === b.plan?.approved &&
    // The chosen answers, which change without `answered` doing so on a
    // multi-question card answered one at a time.
    a.ask?.questions.map((q) => q.chosen.join()).join("|") ===
      b.ask?.questions.map((q) => q.chosen.join()).join("|")
  );
}

/**
 * The conversation so far, plus whatever the last poll said.
 *
 * By id rather than by position: the newest turn is deliberately re-sent on
 * every poll (see readChat), and a widened window overlaps what is already
 * held, so the transcript's own id is the authority.
 *
 * Upsert rather than append. The server does not only add messages, it changes
 * ones it has already sent — a question card is written when the question is
 * put and mutated when the answer arrives. Appending by unseen id meant a
 * card that had been answered minutes ago was still on screen asking, with
 * its buttons live, for the rest of the session.
 */
export function merge(
  prev: ChatMessage[],
  incoming: ChatMessage[],
  /**
   * True when `incoming` is a whole window rather than what is new since the
   * last poll — the first load, and every widening of it. Then `incoming` is
   * the conversation's order and prev is a suffix of it, so appending by
   * unseen id would put the older half at the bottom.
   */
  whole = false,
): ChatMessage[] {
  const held = new Map(prev.map((m) => [m.id, m]));
  if (whole) {
    // Reuse the object already on screen wherever it still says the same
    // thing: a widened window re-sends everything the narrow one held, and
    // handing every bubble a new object would re-parse the whole conversation.
    const out = incoming.map((m) => {
      const was = held.get(m.id);
      return was && same(was, m) ? was : m;
    });
    return out.length === prev.length && out.every((m, i) => m === prev[i]) ? prev : out;
  }
  let changed = false;
  for (const m of incoming) {
    const was = held.get(m.id);
    if (was && same(was, m)) continue;
    held.set(m.id, m);
    changed = true;
  }
  // Nothing new and nothing moved: the same array, so nothing re-renders.
  if (!changed) return prev;
  // Insertion order holds the conversation's order: `held` was built from the
  // list already on screen, and a replacement keeps its place in a Map.
  return [...held.values()];
}

/**
 * Which echoes a poll has answered: one per message it shows as said, oldest
 * first, so two identical sends are cleared one at a time rather than both by
 * the first (C-14). Compared trimmed, which is how the transcript keeps them.
 */
export function settle(echoes: Echo[], said: string[], now = Date.now()): Echo[] {
  const left = [...echoes];
  for (const text of said) {
    const i = left.findIndex((e) => e.text.trim() === text.trim());
    if (i >= 0) left.splice(i, 1);
  }
  const out = left.filter((e) => now - e.at < ECHO_TTL_MS);
  return out.length === echoes.length ? echoes : out;
}

/** How often the transcript is read while the screen is visible, with no push. */
const POLL_MS = 3_000;
/** The backstop while the push is up: it says when to read, this only catches a missed one. */
const PUSHED_POLL_MS = 15_000;

/**
 * A session's transcript, polled and accumulated.
 *
 * Not usePoll: this is the one screen that accumulates rather than replaces.
 * Each request carries the newest timestamp already held, so a poll that finds
 * nothing new costs one repeated turn instead of the whole window every few
 * seconds down a phone tunnel. usePoll would key its effect on that changing
 * URL and reset the list on every new message, which is the opposite of what a
 * conversation wants.
 *
 * Pushed as well as polled: a per-session stream says when the transcript has
 * changed, and the read happens then.
 *
 * One request at a time: the next is scheduled when the last has answered.
 * An interval fired every three seconds whatever the last one was doing, and
 * down a slow tunnel two answers could land out of order (C-25).
 */
export function useSessionChat(sessionId: string) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [pending, setPending] = useState<ChatToolCall[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [todos, setTodos] = useState<ChatTodo[]>([]);
  const [mode, setMode] = useState("");
  const [bytes, setBytes] = useState(WINDOW);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [echoes, setEchoes] = useState<Echo[]>([]);
  /** Which session the messages held belong to. */
  const shownFor = useRef<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let since: string | null = null;
    let conversation: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    // Widening the window is not a change of session: what is on screen is
    // still true, and the wider answer is a superset of it. Blanking it to
    // skeletons and then landing the reader at the bottom of a longer list was
    // the opposite of what "load earlier" is for.
    if (shownFor.current !== sessionId) {
      shownFor.current = sessionId;
      setMessages([]);
      setPending([]);
      setTodos([]);
      setMode("");
      setEchoes([]);
      setLoading(true);
    }

    async function tick() {
      // A tick with nothing to go on asks for the window whole, which is the
      // first one after mounting and after every widening.
      const whole = !since;
      const query = new URLSearchParams({ bytes: String(bytes) });
      if (since) query.set("since", since);
      let chat: SessionChat;
      try {
        chat = await api<SessionChat>(`/api/sessions/${sessionId}/chat?${query}`);
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
      // Replaced rather than appended: both are what the window last saw, so
      // they arrive on every poll including the ones that carry no new turns.
      // Kept by reference when they say the same thing, because a new array
      // every three seconds is a re-render of the whole conversation every
      // three seconds — and `pending` is what the scroll effect watches.
      setPending((prev) => (unchanged(prev, chat.pending) ? prev : chat.pending));
      setTodos((prev) => (unchanged(prev, chat.todos) ? prev : chat.todos));
      setMode(chat.permissionMode);
      if (chat.messages.length) {
        since = chat.messages.at(-1)!.at || since;
        setMessages((prev) => merge(prev, chat.messages, whole));
        // Anything the transcript now shows as said is no longer in flight.
        const said = chat.messages.filter((m) => m.role === "user").map((m) => m.text);
        setEchoes((prev) => settle(prev, said));
      }
    }

    // The push (backend routes/events.ts): "changed" when the transcript grows,
    // so a turn shows within a second rather than at the next poll. The poll
    // stays, slower, for a push that dropped or a proxy that holds it back.
    let pushed = false;
    const push =
      typeof EventSource === "undefined"
        ? null
        : new EventSource(`/api/sessions/${sessionId}/chat/events`);
    push?.addEventListener("changed", () => void run());
    push?.addEventListener("ping", () => (pushed = true));
    push?.addEventListener("error", () => (pushed = false));

    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(() => void run(), pushed ? PUSHED_POLL_MS : POLL_MS);
    };
    const run = async () => {
      if (inFlight || stopped) return;
      if (timer) clearTimeout(timer);
      timer = null;
      if (document.hidden) return schedule();
      inFlight = true;
      try {
        await tick();
      } finally {
        inFlight = false;
        schedule();
      }
    };
    // Back from the background: read now rather than at the end of the wait.
    const onVisible = () => {
      if (!document.hidden) void run();
    };

    void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      push?.close();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [sessionId, bytes]);

  return {
    messages,
    pending,
    truncated,
    todos,
    mode,
    loading,
    error,
    echoes,
    /** A message just sent from here, drawn until the transcript has it. */
    echo: (text: string) => setEchoes((prev) => [...prev, { text: text.trim(), at: Date.now() }]),
    /** "load earlier": four times the window, up to the ceiling. */
    widen: () => setBytes((b) => Math.min(b * 4, MAX_WINDOW)),
  };
}
