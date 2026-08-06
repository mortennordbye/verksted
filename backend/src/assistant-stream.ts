import type { AssistantEntry, AssistantToolCall } from "../../shared/api.js";

/**
 * Turning `claude -p --output-format stream-json` into thread entries.
 *
 * Kept apart from the process that produces it, and pure, because this is the
 * part that will break: the event shape belongs to the CLI, not to us, and the
 * only honest way to survive a change in it is to be able to replay a recorded
 * stream in a test. `assistant.ts` owns the spawning; this owns the reading.
 *
 * What arrives, per the headless docs: newline-delimited JSON, one object per
 * line, with `type` being `system` (subtype `init`, first), `assistant` (a turn
 * of content blocks), `user` (tool results coming back) or `result` (last,
 * carrying is_error). Anything else, and any line that is not JSON at all, is
 * ignored rather than thrown on — a CLI that adds an event type must not take
 * the assistant down with it.
 */

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * The argument worth showing on a chip. Tools disagree about what to call their
 * main argument, and the rest is noise on a phone: a Bash `command` or an Edit
 * `file_path` is the whole story, an Edit's replacement text is not.
 */
const DETAIL_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "prompt"];

export function toolDetail(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return trim(value.trim(), 80);
  }
  return "";
}

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** What one completed run of the CLI produced. */
export interface StreamResult {
  /** Assistant turns, in order. A tool-using run produces more than one. */
  entries: Omit<AssistantEntry, "id" | "at">[];
  /** The session id the CLI reports; should match the one we passed in. */
  conversationId: string | null;
  /** Set when the run ended on an error, from the result event. */
  error: string | null;
}

/**
 * A stream being read as it arrives.
 *
 * Incremental rather than parse-at-the-end, because the CLI emits an assistant
 * turn as soon as the model produces one and the process then carries on
 * running tools — so buffering everything means the answer exists for several
 * seconds before anybody is shown it. That wait was the slowest thing about
 * talking to the assistant, and none of it was the model.
 */
export interface StreamState {
  conversationId: string | null;
  error: string | null;
  pendingTools: AssistantToolCall[];
  /** Bytes arrived since the last newline; a chunk boundary is not a line. */
  buffer: string;
  /**
   * The sentence being written right now, assembled from text deltas. Never
   * persisted: it is replaced by the finished entry moments later, and writing
   * every keystroke to the volume would be a lot of NFS for nothing.
   */
  live: string;
}

export function newStreamState(): StreamState {
  return { conversationId: null, error: null, pendingTools: [], buffer: "", live: "" };
}

type Entry = Omit<AssistantEntry, "id" | "at">;

function consumeEvent(event: Record<string, unknown>, state: StreamState): Entry | null {
  const sessionId = event.session_id;
  if (typeof sessionId === "string" && sessionId) state.conversationId = sessionId;

  // Token-level deltas, which is what makes an answer appear as it is written
  // rather than seconds later in one lump. The finished `assistant` event still
  // follows and is what actually gets stored; this is only what to show while
  // waiting for it.
  if (event.type === "stream_event") {
    const inner = event.event as { type?: string; delta?: { type?: string; text?: string } };
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      state.live += inner.delta.text ?? "";
    }
    return null;
  }

  if (event.type === "assistant") {
    const message = event.message as { content?: ContentBlock[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!.trim())
      .filter(Boolean)
      .join("\n\n");
    for (const b of blocks) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        state.pendingTools.push({ name: b.name, detail: toolDetail(b.input) });
      }
    }
    // A turn that is only tool calls carries its tools forward to whichever
    // turn finally says something, rather than becoming an empty bubble.
    if (text) {
      const entry = { role: "assistant" as const, text, tools: state.pendingTools };
      state.pendingTools = [];
      state.live = "";
      return entry;
    }
    // A tool-only turn: whatever was being written was the model thinking out
    // loud towards the call, and the call is now the thing to show.
    state.live = "";
    return null;
  }

  if (event.type === "result") {
    if (
      event.is_error === true ||
      (typeof event.subtype === "string" && event.subtype !== "success")
    ) {
      const detail =
        typeof event.result === "string" && event.result.trim() ? event.result.trim() : null;
      state.error =
        detail ?? (typeof event.subtype === "string" ? event.subtype : "the run failed");
    }
  }
  return null;
}

/**
 * Feed a chunk of stdout; get back whatever entries completed inside it.
 *
 * A chunk is not a line: the last one is usually a fragment, so it is held
 * until its newline arrives rather than parsed and thrown away as bad JSON.
 */
export function consumeChunk(chunk: string, state: StreamState): Entry[] {
  state.buffer += chunk;
  const lines = state.buffer.split("\n");
  state.buffer = lines.pop() ?? "";
  const out: Entry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON: a warning the CLI printed to stdout. Not ours to interpret.
      continue;
    }
    const entry = consumeEvent(event, state);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * What is left when the process ends: anything in the buffer, plus tool calls
 * nothing was ever said after — a turn that used them and then died is more
 * legible with them than without.
 */
export function finishStream(state: StreamState): Entry[] {
  const out = state.buffer.trim() ? consumeChunk("\n", state) : [];
  if (state.pendingTools.length) {
    out.push({ role: "assistant", text: "", tools: state.pendingTools });
    state.pendingTools = [];
  }
  return out;
}

/** Fold a whole stream at once. The incremental path is what runs in anger. */
export function parseStream(raw: string): StreamResult {
  const state = newStreamState();
  const entries = [...consumeChunk(raw, state), ...finishStream(state)];
  return { entries, conversationId: state.conversationId, error: state.error };
}
