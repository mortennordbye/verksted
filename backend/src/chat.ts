import fs from "node:fs/promises";
import type { ChatMessage, ChatToolCall, SessionChat } from "../../shared/api.js";
import { toolDetail } from "./assistant-stream.js";

/**
 * A session read as a conversation, out of the transcript the agent already
 * writes.
 *
 * The terminal is the truth about a session and stays that way; this is the
 * same session with the chrome taken off. It exists because a TUI is a bad
 * place to read from a phone — the pane is 40 columns, a tool result scrolls
 * the answer off the top, and the thing you actually wanted (what did it say,
 * what did it do, did anything fail) is buried in redraw noise.
 *
 * The whole point is that it costs nothing. Claude Code writes every turn to
 * $HOME/.claude/projects/<cwd>/<conversation>.jsonl as it goes, so this is a
 * file read and a JSON.parse. Nothing is replayed, nothing is summarised, no
 * second model is asked what happened — the same view would otherwise be a
 * per-poll model call over a megabyte of transcript.
 *
 * What is dropped is as deliberate as what is kept:
 *
 * - **Tool results.** They are the bulk of the file — whole test runs, whole
 *   files — and they are what makes the terminal unreadable in the first
 *   place. The call survives as a chip; only a result that came back an error
 *   leaves a mark, on the chip it belongs to.
 * - **Thinking.** Reasoning towards an answer is not the answer, and it is the
 *   longest thing in the transcript after tool results.
 * - **Sidechains.** A subagent's conversation is interleaved into the same
 *   file. Rendered in line it reads as the main agent suddenly talking to
 *   itself about something else.
 */

/** How much of the tail to read when the caller does not say. */
export const DEFAULT_WINDOW = 256_000;
/** The most any one request may read, so "load earlier" cannot ask for a GB. */
export const MAX_WINDOW = 8_000_000;

/** One block of a message's content array. */
interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

/** One line of the transcript. Only the fields this file reads. */
interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
}

/**
 * The last `bytes` of a file, from the first line boundary inside the window.
 *
 * Anchored to the end rather than paged from the start because a conversation
 * is read from the bottom: the interesting turn is the last one, always. That
 * makes the request stateless — no cursor to keep, no cache to invalidate
 * against a file being appended to while it is read — and it bounds the work
 * regardless of how long the session ran.
 *
 * Starting mid-file lands in the middle of a line, and possibly in the middle
 * of a UTF-8 sequence. Both are the same fix: drop everything before the first
 * newline. What is left is whole lines from a valid boundary.
 */
async function tail(file: string, bytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) await handle.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    if (start === 0) return { text, truncated: false };
    const nl = text.indexOf("\n");
    // No newline at all: the window landed inside one enormous line and there
    // is nothing in it that can be parsed.
    return { text: nl === -1 ? "" : text.slice(nl + 1), truncated: true };
  } finally {
    await handle.close();
  }
}

/** The text blocks of a message, joined; "" when it only made tool calls. */
function textOf(blocks: Block[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Turn a run of transcript lines into turns.
 *
 * Tool calls accumulate and attach to the next thing the agent says, which is
 * the order they happened in: "it ran these, then it said this". Anything still
 * accumulated when the lines run out is work in flight, and comes back as
 * `pending` rather than being hidden until the reply lands — on a live session
 * that is the difference between watching it work and watching nothing.
 */
export function parseTranscript(text: string): {
  messages: ChatMessage[];
  pending: ChatToolCall[];
} {
  const messages: ChatMessage[] = [];
  let pending: ChatToolCall[] = [];
  // Only for the span held in `pending`: once a chip is attached to a message
  // its result has long since been seen, and keeping every id would grow with
  // the conversation for nothing.
  let byToolId = new Map<string, ChatToolCall>();

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      // One torn line costs one turn, never the rest of the window.
      continue;
    }
    // A subagent's turns, in the same file as the agent that spawned it.
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    const at = entry.timestamp ?? "";
    const id = entry.uuid ?? "";

    if (entry.type === "user") {
      // The person at the keyboard: tagged by the record, and always a plain
      // string. A tool result wears the same role with structured content, and
      // this is the check that tells them apart (see transcripts.ts).
      if (entry.origin?.kind === "human" && typeof content === "string") {
        const text = content.trim();
        if (!text) continue;
        // Whatever it was doing when the user cut in belongs before them, not
        // attached to whatever it says next.
        if (pending.length) {
          messages.push({ id: `${id}:tools`, role: "assistant", text: "", tools: pending, at });
          pending = [];
          byToolId = new Map();
        }
        messages.push({ id, role: "user", text, tools: [], at });
        continue;
      }
      // A result. The output is dropped; only a failure marks its chip.
      if (Array.isArray(content)) {
        for (const b of content as Block[]) {
          if (b?.type !== "tool_result" || !b.is_error) continue;
          const chip = byToolId.get(b.tool_use_id ?? "");
          if (chip) chip.failed = true;
        }
      }
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const blocks = content as Block[];
      const text = textOf(blocks);
      // Text first, then this message's own calls: the sentence was written
      // before the call it leads into, so the call belongs to the next turn.
      if (text) {
        messages.push({ id, role: "assistant", text, tools: pending, at });
        pending = [];
        byToolId = new Map();
      }
      for (const b of blocks) {
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        const chip: ChatToolCall = { name: b.name, detail: toolDetail(b.input) };
        pending.push(chip);
        if (b.id) byToolId.set(b.id, chip);
      }
    }
  }
  return { messages, pending };
}

/**
 * The conversation, or an empty one when there is nothing to read.
 *
 * A missing transcript is not an error: an agent other than claude writes none,
 * and a session that has only just started has not written its first line yet.
 * Both are "no messages", which the screen already knows how to show.
 */
export async function readChat(
  file: string | null,
  conversationId: string | null,
  opts: { bytes?: number; since?: string } = {},
): Promise<SessionChat> {
  const empty: SessionChat = { conversationId, messages: [], pending: [], truncated: false };
  if (!file) return empty;
  let window: { text: string; truncated: boolean };
  try {
    window = await tail(file, Math.min(opts.bytes ?? DEFAULT_WINDOW, MAX_WINDOW));
  } catch {
    return empty;
  }
  const { messages, pending } = parseTranscript(window.text);
  return {
    conversationId,
    // Everything the caller has not got. A poll that finds nothing new is then
    // a few hundred bytes rather than the whole window every few seconds, which
    // over a phone tunnel is the difference worth the query parameter.
    //
    // Inclusive, so the newest turn is re-sent every poll. Two entries can share
    // a millisecond — the tool-only turn flushed ahead of an interruption takes
    // the timestamp of the message that triggered it — and an exclusive filter
    // would drop the second one for good if it landed after the first was read.
    // Costs one message per poll; the client discards it by id.
    messages: opts.since ? messages.filter((m) => m.at >= opts.since!) : messages,
    pending,
    truncated: window.truncated,
  };
}
