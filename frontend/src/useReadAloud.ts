import { useCallback, useEffect, useRef } from "react";
import type { AssistantEntry, AssistantThread } from "../../shared/api";

/**
 * Read what has not been read yet, in order, each in its speaker's voice.
 *
 * A meeting produces several replies at once, so this is a queue rather than
 * "the last one". Reading them all only became the right answer once each
 * advisor had a voice of its own: in one voice it is four answers that sound
 * like one person changing their mind, which is why it used to read the
 * chair's summary alone.
 *
 * Keyed on entry ids already spoken, so a reconnecting socket redelivering the
 * whole thread cannot read anything twice. Everything already in a
 * conversation when it comes on screen counts as read: "read replies aloud" is
 * remembered per device, so it is on before the screen mounts, and without
 * that the socket's first frame started reading the whole history out, from
 * the top, every single visit.
 *
 * Its own hook, out of the chat screen, so that is something a test can pin.
 */
export function useReadAloud({
  thread,
  on,
  speak,
  voiceOf,
  onDone,
}: {
  thread: AssistantThread | null;
  /** Reading aloud or hands-free: either one reads. */
  on: boolean;
  speak: (text: string, onDone: () => void, voice?: string) => void;
  voiceOf: (entry: AssistantEntry) => string | undefined;
  /** After the last of a batch has been read: hands-free reopens the microphone. */
  onDone: () => void;
}): { markRead: (entries: AssistantEntry[]) => void } {
  const spoken = useRef<Set<string>>(new Set());
  /** Which thread the set above has been filled in for. */
  const primed = useRef<string | null>(null);
  // Read through refs, so a new function from the screen each render does not
  // count as a reason to read again.
  const fns = useRef({ speak, voiceOf, onDone });
  useEffect(() => {
    fns.current = { speak, voiceOf, onDone };
  });

  const thinking = thread?.status === "thinking";

  useEffect(() => {
    if (!thread) return;
    // First sight of this conversation: everything in it was said before anyone
    // was listening. Also covers switching threads and starting a new one.
    if (primed.current !== thread.conversationId) {
      primed.current = thread.conversationId;
      spoken.current = new Set(thread.entries.map((e) => e.id));
      return;
    }
    if (!on || thinking) return;
    const pending = thread.entries.filter(
      (e) => e.role === "assistant" && e.text && !spoken.current.has(e.id),
    );
    if (!pending.length) return;
    for (const e of pending) spoken.current.add(e.id);

    const readFrom = (i: number) => {
      const entry = pending[i];
      if (!entry) return fns.current.onDone();
      fns.current.speak(entry.text, () => readFrom(i + 1), fns.current.voiceOf(entry));
    };
    readFrom(0);
  }, [thread, on, thinking]);

  const markRead = useCallback((entries: AssistantEntry[]) => {
    for (const e of entries) spoken.current.add(e.id);
  }, []);

  return { markRead };
}
