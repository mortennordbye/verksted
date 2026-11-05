import type { AssistantEntry, AssistantFrame, AssistantThread } from "../../shared/api.js";

/**
 * What one socket has been sent, and the smallest frame that brings it up to date.
 *
 * A frame used to carry the whole reply so far, ten times a second, and the whole
 * thread on every new entry: bytes that grew with the square of the reply, on a
 * phone on a tunnel. It also gave every old entry a new identity, so everything
 * already on screen parsed its markdown again.
 *
 * Anything that does not fit an append goes whole, because the last state is the
 * true one. A frame the client cannot apply makes it reconnect, which sends whole.
 */
export interface Sent {
  entries: AssistantEntry[] | null;
  live: string;
}

export function freshSent(): Sent {
  return { entries: null, live: "" };
}

function appendedTo(sent: AssistantEntry[], now: AssistantEntry[]): AssistantEntry[] | null {
  if (now.length < sent.length) return null;
  const last = sent.at(-1);
  if (last && now[sent.length - 1]?.id !== last.id) return null;
  return now.slice(sent.length);
}

export function frameFor(thread: AssistantThread, sent: Sent): AssistantFrame {
  const { entries, live, ...rest } = thread;
  const frame: AssistantFrame = { ...rest, entries: undefined };

  if (entries !== sent.entries) {
    const added = sent.entries ? appendedTo(sent.entries, entries) : null;
    if (added) {
      frame.appended = added;
      frame.after = sent.entries?.length ?? 0;
    } else {
      frame.entries = entries;
    }
    sent.entries = entries;
  }

  if (live && sent.live && live.startsWith(sent.live)) {
    frame.liveFrom = sent.live.length;
    frame.liveDelta = live.slice(sent.live.length);
  } else if (live) {
    frame.live = live;
  }
  sent.live = live ?? "";
  return frame;
}
