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
 * Fold a whole stream into entries. Text blocks within one assistant event are
 * joined; tool calls are attached to the entry they were requested in, so the
 * chat can draw "read 3 runs" above the sentence that used it.
 */
export function parseStream(raw: string): StreamResult {
  const entries: Omit<AssistantEntry, "id" | "at">[] = [];
  let conversationId: string | null = null;
  let error: string | null = null;
  let pendingTools: AssistantToolCall[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not JSON: a warning the CLI printed to stdout, or a partial line from a
      // process that died mid-write. Neither is ours to interpret.
      continue;
    }

    const sessionId = event.session_id;
    if (typeof sessionId === "string" && sessionId) conversationId = sessionId;

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
          pendingTools.push({ name: b.name, detail: toolDetail(b.input) });
        }
      }
      // A turn that is only tool calls carries its tools forward to whichever
      // turn finally says something, rather than becoming an empty bubble.
      if (text) {
        entries.push({ role: "assistant", text, tools: pendingTools });
        pendingTools = [];
      }
      continue;
    }

    if (event.type === "result") {
      if (
        event.is_error === true ||
        (typeof event.subtype === "string" && event.subtype !== "success")
      ) {
        const detail =
          typeof event.result === "string" && event.result.trim() ? event.result.trim() : null;
        error = detail ?? (typeof event.subtype === "string" ? event.subtype : "the run failed");
      }
    }
  }

  // Tools with nothing said after them still happened, and a turn that used
  // them and then died is more legible with them than without.
  if (pendingTools.length) {
    entries.push({ role: "assistant", text: "", tools: pendingTools });
  }

  return { entries, conversationId, error };
}
