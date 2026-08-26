import fs from "node:fs/promises";
import type {
  ChatEventKind,
  ChatMessage,
  ChatTodo,
  ChatToolCall,
  SessionChat,
} from "../../shared/api.js";
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
 * What travels here is what a phone can hold: turns, chips, and one-line rails
 * for the things that happened to the session rather than in it. What is
 * *large* — a tool's output, an edit's diff, a plan, an image — is fetched by
 * id when somebody taps it, so the cost of a poll does not move with the size
 * of a test run. That is the whole bargain, and it is why the chip carries the
 * transcript's own `tool_use` id rather than a summary of the call.
 *
 * What stays dropped is per-turn bookkeeping that shows nothing: `mode`,
 * `ai-title` and `last-prompt` are written once per turn each and say only what
 * the screen already says, and `total_tokens_reminder` is five sixths of the
 * attachments. Unknown entry types are ignored rather than guessed at — the CLI
 * adds them (`atis-latch` arrived without warning), and one must never take the
 * line after it down with it.
 *
 * Not dropped but not available: `thinking` blocks are written with an empty
 * body and a signature, so what it reasoned is not on disk to show. The
 * duration rail is the honest substitute — it says a turn took a while without
 * pretending to know what was in it.
 */

/** How much of the tail to read when the caller does not say. */
export const DEFAULT_WINDOW = 256_000;
/** The most any one request may read, so "load earlier" cannot ask for a GB. */
export const MAX_WINDOW = 8_000_000;

/** A queued prompt or an API error: enough to recognise, not to re-read. */
const EVENT_TEXT_CHARS = 200;

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

/** One item of the checklist, as the `task_reminder` attachment carries it. */
interface ReminderItem {
  subject?: string;
  status?: string;
}

/** One line of the transcript. Only the fields this file reads. */
interface Entry {
  type?: string;
  uuid?: string;
  timestamp?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  origin?: { kind?: string };
  message?: { role?: string; content?: unknown };
  /** Entries the CLI writes beside the conversation rather than in it. */
  attachment?: { type?: string; content?: unknown; prompt?: unknown };
  permissionMode?: string;
  prUrl?: string;
  prNumber?: number;
  subtype?: string;
  durationMs?: number;
  hookErrors?: unknown[];
}

/** What the CLI wrote when the person hit escape. */
const INTERRUPTED = "[Request interrupted by user]";

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

function trim(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A duration the way the CLI says it: "3.2s", "1m 21s". */
function saidDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** The name and arguments of a slash command, out of the scaffolding around it. */
function slashCommand(text: string): string | null {
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1]?.trim();
  if (!name) return null;
  const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
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
  todos: ChatTodo[];
  permissionMode: string;
} {
  const messages: ChatMessage[] = [];
  let pending: ChatToolCall[] = [];
  // Only for the span held in `pending`: once a chip is attached to a message
  // its result has long since been seen, and keeping every id would grow with
  // the conversation for nothing.
  let byToolId = new Map<string, ChatToolCall>();
  let todos: ChatTodo[] = [];
  let permissionMode = "";
  // The CLI re-states the pull request on every turn once there is one, so a
  // window of any length carries the same link dozens of times. Only the first
  // sighting is news; the rest is the same fact restated.
  const prsSeen = new Set<string>();

  /**
   * Where a rail hangs.
   *
   * `permission-mode` and `pr-link` are written with no uuid at all, and the
   * client accumulates by id while the server filters by timestamp — so a rail
   * borrows both from the last entry that had them, plus its position after
   * that entry. Stable across polls and across a widened window, because the
   * anchor is the transcript's own uuid rather than anything counted here.
   */
  let anchorId = "";
  let anchorAt = "";
  let anchorSeq = 0;

  function rail(event: ChatEventKind, said: string, at?: string, href?: string): void {
    messages.push({
      id: `${anchorId}:e${++anchorSeq}`,
      role: "event",
      text: said,
      tools: [],
      at: at || anchorAt,
      event,
      ...(href ? { href } : {}),
    });
  }

  /** Whatever it was doing belongs before what interrupted it, not after. */
  function flushTools(id: string, at: string): void {
    if (!pending.length) return;
    messages.push({ id: `${id}:tools`, role: "assistant", text: "", tools: pending, at });
    pending = [];
    byToolId = new Map();
  }

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      // One torn line costs one turn, never the rest of the window.
      continue;
    }
    // A subagent's turns. The current CLI writes these to their own file beside
    // the conversation; older transcripts interleave them here, where rendered
    // in line they read as the agent suddenly talking to itself.
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    const at = entry.timestamp ?? "";
    const id = entry.uuid ?? "";
    if (id) {
      anchorId = id;
      anchorAt = at || anchorAt;
      anchorSeq = 0;
    }

    if (entry.type === "user") {
      if (typeof content === "string") {
        const said = content.trim();
        // Scaffolding the CLI writes as though the person had typed it: system
        // reminders, the caveat on a local command, the note left where an
        // image was. All of it is tagged, and none of it is words.
        if (!said || entry.isMeta) continue;
        // `origin` separates the person from a notification wearing their role.
        // Absent entirely on older entries, which are the person by default.
        if (entry.origin?.kind && entry.origin.kind !== "human") continue;
        // A slash command arrives as its own XML rather than as the line that
        // was typed. It is worth a rail — "/clear happened here" — and it is
        // emphatically not worth a user bubble full of tags.
        if (said.startsWith("<")) {
          const command = slashCommand(said);
          if (command) rail("command", command, at);
          continue;
        }
        flushTools(id, at);
        messages.push({ id, role: "user", text: said, tools: [], at });
        continue;
      }
      if (Array.isArray(content)) {
        const blocks = content as Block[];
        // A result. The output is dropped; only a failure marks its chip, and
        // the rest is fetched by id if anybody wants to read it.
        for (const b of blocks) {
          if (b?.type !== "tool_result" || !b.is_error) continue;
          const chip = byToolId.get(b.tool_use_id ?? "");
          if (chip) chip.failed = true;
        }
        if (blocks.some((b) => b?.type === "text" && b.text?.includes(INTERRUPTED))) {
          flushTools(id, at);
          rail("interrupted", "you interrupted it", at);
        }
      }
      continue;
    }

    if (entry.type === "assistant" && Array.isArray(content)) {
      const blocks = content as Block[];
      const said = textOf(blocks);
      // A turn the API failed rather than one the agent wrote.
      if (entry.isApiErrorMessage) {
        if (said) rail("error", trim(said, EVENT_TEXT_CHARS), at);
        continue;
      }
      // Text first, then this message's own calls: the sentence was written
      // before the call it leads into, so the call belongs to the next turn.
      if (said) {
        messages.push({ id, role: "assistant", text: said, tools: pending, at });
        pending = [];
        byToolId = new Map();
      }
      for (const b of blocks) {
        if (b.type !== "tool_use" || typeof b.name !== "string") continue;
        const chip: ChatToolCall = { id: b.id ?? "", name: b.name, detail: toolDetail(b.input) };
        pending.push(chip);
        if (b.id) byToolId.set(b.id, chip);
      }
      continue;
    }

    if (entry.type === "attachment") {
      const kind = entry.attachment?.type;
      if (kind === "task_reminder") {
        // The whole list, every time — so the newest one in the window is the
        // checklist, and nothing has to be reconstructed from the calls that
        // built it.
        const items = entry.attachment?.content;
        todos = Array.isArray(items)
          ? (items as ReminderItem[])
              .filter((i) => typeof i?.subject === "string")
              .map((i) => ({
                subject: i.subject!,
                status:
                  i.status === "in_progress" || i.status === "completed" ? i.status : "pending",
              }))
          : [];
      } else if (kind === "queued_command" && typeof entry.attachment?.prompt === "string") {
        // Typed while it was busy: it happened here, and it will be taken later.
        const said = entry.attachment.prompt.trim();
        if (said) {
          flushTools(id, at);
          rail("queued", trim(said, EVENT_TEXT_CHARS), at);
        }
      }
      continue;
    }

    if (entry.type === "pr-link" && typeof entry.prUrl === "string") {
      if (!prsSeen.has(entry.prUrl)) {
        prsSeen.add(entry.prUrl);
        rail("pr", entry.prNumber ? `#${entry.prNumber}` : "pull request", at, entry.prUrl);
      }
      continue;
    }

    if (entry.type === "permission-mode" && typeof entry.permissionMode === "string") {
      const mode = entry.permissionMode;
      if (!mode || mode === permissionMode) continue;
      // The first value a window sees is the mode it was already in, not a
      // change somebody made — a rail for it would be a lie on every reconnect
      // and on every widening of the window.
      if (permissionMode) rail("mode", `${mode} mode`, at);
      permissionMode = mode;
      continue;
    }

    if (entry.type === "system") {
      if (entry.subtype === "turn_duration" && typeof entry.durationMs === "number") {
        rail("duration", saidDuration(entry.durationMs), at);
      } else if (entry.subtype === "stop_hook_summary" && entry.hookErrors?.length) {
        rail("hook", "a stop hook reported an error", at);
      }
      continue;
    }
  }
  return { messages, pending, todos, permissionMode };
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
  const empty: SessionChat = {
    conversationId,
    messages: [],
    pending: [],
    truncated: false,
    todos: [],
    permissionMode: "",
  };
  if (!file) return empty;
  let window: { text: string; truncated: boolean };
  try {
    window = await tail(file, Math.min(opts.bytes ?? DEFAULT_WINDOW, MAX_WINDOW));
  } catch {
    return empty;
  }
  const { messages, pending, todos, permissionMode } = parseTranscript(window.text);
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
    // State, not a delta: both are what the window last saw, so neither is
    // filtered by `since`. A client that has caught up still needs to know what
    // the checklist says and which mode it is in.
    todos,
    permissionMode,
  };
}
