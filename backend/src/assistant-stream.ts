import type { AssistantEntry, AssistantToolCall, SessionUsage } from "../../shared/api.js";

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
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  content?: unknown;
  source?: { media_type?: string; data?: string };
}

/** A picture a tool handed back, still as bytes: assistant.ts decides where it lands. */
export interface Shot {
  mediaType: string;
  data: string;
}

const SHOT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

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
  entries: Entry[];
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
  /**
   * What the run took, from its result event. The CLI has always reported it
   * and it used to be dropped, which left the assistant the one thing on this
   * bench whose cost nobody could see.
   */
  usage: SessionUsage | null;
  /**
   * Prompt tokens of the last model call: the conversation as it now stands,
   * which is what the next turn sends again before it has said a word.
   */
  context: number;
  pendingTools: AssistantToolCall[];
  /** Pictures tools returned, carried to the next thing said like the tools are. */
  pendingShots: Shot[];
  /** Tool names by call id, so a result can be told apart by what made it. */
  toolNames: Map<string, string>;
  /** Bytes arrived since the last newline; a chunk boundary is not a line. */
  buffer: string;
  /**
   * The sentence being written right now, assembled from text deltas. Never
   * persisted: it is replaced by the finished entry moments later, and writing
   * every keystroke to the volume would be a lot of NFS for nothing.
   */
  live: string;
  /**
   * What the model is thinking right now, from thinking deltas. Shown and never
   * stored, like `live`: "thinking…" over a minute of nothing was the complaint,
   * and what it is reasoning about is the honest answer to "what is it doing".
   */
  thinking: string;
  /** A tool call being written, named before its arguments have arrived. */
  writingTool: string | null;
  /**
   * Called the moment a tool is asked for, rather than when the entry carrying
   * it completes. Used to notice that a turn has fetched something: what that
   * costs it has to be decided before the next tool call, not after the model
   * has finished writing the sentence around it.
   */
  onTool?: (name: string) => void;
}

export function newStreamState(onTool?: (name: string) => void): StreamState {
  return {
    ...(onTool ? { onTool } : {}),
    conversationId: null,
    error: null,
    usage: null,
    context: 0,
    pendingTools: [],
    pendingShots: [],
    toolNames: new Map(),
    buffer: "",
    live: "",
    thinking: "",
    writingTool: null,
  };
}

/** What a turn in flight has to show: the three things `live*` in the thread carry. */
export interface LiveView {
  text: string;
  thinking: string;
  tools: AssistantToolCall[];
}

/**
 * The turn as it stands, for the screen. The tools are the calls made since
 * anything was last said, which is what the finished entry will carry, plus the
 * one being written, so a chip appears as the model reaches for the tool rather
 * than once it has written a sentence after it.
 */
export function liveView(state: StreamState): LiveView {
  const tools = state.writingTool
    ? [...state.pendingTools, { name: state.writingTool, detail: "" }]
    : state.pendingTools;
  return { text: state.live, thinking: state.thinking, tools };
}

/** The four counts the API reports, under this app's names for them. */
function tokens(usage: unknown): Omit<SessionUsage, "turns" | "costUsd"> | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const n = (key: string) => (typeof u[key] === "number" ? u[key] : 0);
  return {
    input: n("input_tokens"),
    output: n("output_tokens"),
    cacheRead: n("cache_read_input_tokens"),
    cacheWrite: n("cache_creation_input_tokens"),
  };
}

/** An entry as parsed: `shots` become upload names before it is stored. */
export type Entry = Omit<AssistantEntry, "id" | "at"> & { shots?: Shot[] };

function consumeEvent(event: Record<string, unknown>, state: StreamState): Entry | null {
  const sessionId = event.session_id;
  if (typeof sessionId === "string" && sessionId) state.conversationId = sessionId;

  // Token-level deltas, which is what makes an answer appear as it is written
  // rather than seconds later in one lump. The finished `assistant` event still
  // follows and is what actually gets stored; this is only what to show while
  // waiting for it.
  if (event.type === "stream_event") {
    const inner = event.event as {
      type?: string;
      delta?: { type?: string; text?: string; thinking?: string };
      content_block?: { type?: string; name?: string };
    };
    if (inner?.type === "content_block_start" && inner.content_block?.type === "tool_use") {
      state.writingTool = inner.content_block.name ?? null;
      // Told as the call starts as well as once it is complete: the taint rule
      // wants to know as early as there is anything to know.
      if (state.writingTool) state.onTool?.(state.writingTool);
    } else if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta") {
      state.live += inner.delta.text ?? "";
    } else if (inner?.type === "content_block_delta" && inner.delta?.type === "thinking_delta") {
      state.thinking += inner.delta.thinking ?? "";
    }
    return null;
  }

  if (event.type === "assistant") {
    const message = event.message as { content?: ContentBlock[]; usage?: unknown } | undefined;
    const prompt = tokens(message?.usage);
    if (prompt) state.context = prompt.input + prompt.cacheRead + prompt.cacheWrite;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (blocks.some((b) => b.type === "tool_use")) state.writingTool = null;
    const text = blocks
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!.trim())
      .filter(Boolean)
      .join("\n\n");
    for (const b of blocks) {
      if (b.type === "tool_use" && typeof b.name === "string") {
        state.pendingTools.push({ name: b.name, detail: toolDetail(b.input) });
        state.onTool?.(b.name);
        if (b.id) state.toolNames.set(b.id, b.name);
      }
    }
    // A turn that is only tool calls carries its tools forward to whichever
    // turn finally says something, rather than becoming an empty bubble.
    if (text) {
      const entry: Entry = { role: "assistant", text, tools: state.pendingTools };
      if (state.pendingShots.length) entry.shots = state.pendingShots;
      state.pendingTools = [];
      state.pendingShots = [];
      state.live = "";
      state.thinking = "";
      return entry;
    }
    // A tool-only turn: whatever was being written was the model thinking out
    // loud towards the call, and the call is now the thing to show.
    state.live = "";
    return null;
  }

  // Tool results. Only a picture is kept: a screenshot is what the chair is
  // about to ask you to confirm, and saying "here it is" without showing it
  // was the complaint. Read is left out, since the picture it returns is one
  // you attached and can already see above.
  if (event.type === "user") {
    const message = event.message as { content?: ContentBlock[] } | undefined;
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const b of blocks) {
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      if (state.toolNames.get(b.tool_use_id ?? "") === "Read") continue;
      for (const c of b.content as ContentBlock[]) {
        const mediaType = c.source?.media_type;
        const data = c.source?.data;
        if (
          c.type === "image" &&
          mediaType &&
          SHOT_TYPES.has(mediaType) &&
          typeof data === "string"
        ) {
          state.pendingShots.push({ mediaType, data });
        }
      }
    }
    return null;
  }

  if (event.type === "result") {
    const used = tokens(event.usage);
    if (used) {
      state.usage = {
        ...used,
        turns: typeof event.num_turns === "number" ? event.num_turns : 0,
        ...(typeof event.total_cost_usd === "number" ? { costUsd: event.total_cost_usd } : {}),
      };
    }
    if (
      event.is_error === true ||
      (typeof event.subtype === "string" && event.subtype !== "success")
    ) {
      // A run that failed before it reached the model has no `result`, only
      // `errors` — and without them all that is left is the subtype, which says
      // "error_during_execution" for everything.
      const errors = Array.isArray(event.errors)
        ? event.errors.filter((e): e is string => typeof e === "string").join("\n")
        : "";
      const detail =
        typeof event.result === "string" && event.result.trim()
          ? event.result.trim()
          : errors.trim() || null;
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
  if (state.pendingTools.length || state.pendingShots.length) {
    out.push({
      role: "assistant",
      text: "",
      tools: state.pendingTools,
      ...(state.pendingShots.length ? { shots: state.pendingShots } : {}),
    });
    state.pendingTools = [];
    state.pendingShots = [];
  }
  return out;
}

/** Fold a whole stream at once. The incremental path is what runs in anger. */
export function parseStream(raw: string): StreamResult {
  const state = newStreamState();
  const entries = [...consumeChunk(raw, state), ...finishStream(state)];
  return { entries, conversationId: state.conversationId, error: state.error };
}
