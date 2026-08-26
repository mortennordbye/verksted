import fs from "node:fs/promises";
import type {
  ChatAsk,
  ChatDetail,
  ChatEventKind,
  ChatPlan,
  ChatQuestion,
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

/**
 * The most of one call's arguments or output to hand back.
 *
 * Generous, because this is what somebody asked to see and a truncated stack
 * trace is worth less than none; bounded, because a test run can print
 * megabytes and past this the terminal is the right place to read it.
 */
export const MAX_DETAIL_CHARS = 128_000;

/** One block of a message's content array. */
interface Block {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  id?: string;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

/** One hunk of the patch an edit records against itself. */
interface Hunk {
  oldStart?: number;
  oldLines?: number;
  newStart?: number;
  newLines?: number;
  lines?: string[];
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
  /** What a tool actually returned, which the content block only summarises. */
  toolUseResult?: unknown;
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

/** The questions an AskUserQuestion put, as the card will draw them. */
function questionsOf(input: Record<string, unknown> | undefined): ChatQuestion[] {
  const asked = input?.questions;
  if (!Array.isArray(asked)) return [];
  return (asked as Record<string, unknown>[])
    .filter((q) => typeof q?.question === "string")
    .map((q) => ({
      header: typeof q.header === "string" ? q.header : "",
      question: q.question as string,
      multiSelect: q.multiSelect === true,
      options: Array.isArray(q.options)
        ? (q.options as Record<string, unknown>[])
            .filter((o) => typeof o?.label === "string")
            .map((o) => ({
              label: o.label as string,
              description: typeof o.description === "string" ? o.description : "",
              ...(typeof o.preview === "string" && o.preview ? { preview: o.preview } : {}),
            }))
        : [],
      chosen: [],
    }));
}

/** What a plan is called: its first heading, or failing that its first line. */
function planTitle(markdown: string): string {
  for (const line of markdown.split("\n")) {
    const said = line.trim();
    if (!said) continue;
    return said.replace(/^#+\s*/, "");
  }
  return "a plan";
}

/**
 * The answer the person gave, put back on the question it answered.
 *
 * The transcript keys the answers by the question's own text and joins the
 * chosen labels with a comma, which is lossy in principle — a label containing
 * ", " would split wrongly — so a split is only trusted when every piece of it
 * is a label that was actually offered.
 */
function applyAnswers(ask: ChatAsk, answers: Record<string, unknown>): void {
  ask.answered = true;
  for (const question of ask.questions) {
    const given = answers[question.question];
    if (typeof given !== "string" || !given) continue;
    const labels = question.options.map((o) => o.label);
    const split = given.split(", ");
    question.chosen = split.every((piece) => labels.includes(piece)) ? split : [given];
  }
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
  // Kept for the whole window, unlike `byToolId`. A chip's result lands within
  // a turn, but a question can sit unanswered for as long as somebody takes to
  // read it — and there are a handful of these in a session where there are
  // hundreds of chips, so the map does not grow into anything.
  const byCardId = new Map<string, { ask?: ChatAsk; plan?: ChatPlan }>();

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
          if (b?.type !== "tool_result") continue;
          if (b.is_error) {
            const chip = byToolId.get(b.tool_use_id ?? "");
            if (chip) chip.failed = true;
          }
          const card = byCardId.get(b.tool_use_id ?? "");
          if (!card) continue;
          const answers = (entry.toolUseResult as { answers?: unknown } | undefined)?.answers;
          if (card.ask && answers && typeof answers === "object") {
            applyAnswers(card.ask, answers as Record<string, unknown>);
          } else if (card.ask) {
            // It came back without an answers map at all — dismissed, or
            // interrupted. Still not open, so it stops asking.
            card.ask.answered = true;
          }
          if (card.plan) {
            // Approval is matched positively and everything else is a refusal:
            // the wordings for going back to planning vary, and reading a
            // refusal as an approval is the expensive direction to be wrong in.
            const said = typeof b.content === "string" ? b.content : "";
            card.plan.approved = said.startsWith("User has approved your plan");
          }
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
        // Two calls are the CLI's own interface rather than work it did, and
        // they get a card each. They flush a turn of their own because a
        // tool-only entry produces no message — a question left riding in
        // `pending` would never be drawn, which is exactly when it matters.
        if (b.name === "AskUserQuestion") {
          const questions = questionsOf(b.input);
          if (!questions.length) continue;
          flushTools(id, at);
          const ask: ChatAsk = { id: b.id ?? "", questions, answered: false };
          messages.push({ id: `${id}:ask`, role: "assistant", text: "", tools: [], at, ask });
          if (b.id) byCardId.set(b.id, { ask });
          continue;
        }
        if (b.name === "ExitPlanMode" && typeof b.input?.plan === "string") {
          flushTools(id, at);
          const markdown = b.input.plan;
          const plan: ChatPlan = {
            id: b.id ?? "",
            title: planTitle(markdown),
            chars: markdown.length,
            approved: null,
          };
          messages.push({ id: `${id}:plan`, role: "assistant", text: "", tools: [], at, plan });
          if (b.id) byCardId.set(b.id, { plan });
          continue;
        }
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

/** The text a tool_result block carries, ignoring anything that is not words. */
function resultBlockText(block: Block): string {
  const { content } = block;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Never the image blocks: their base64 is the thing this whole design keeps
  // off the wire, and it is served as bytes by its own route instead.
  return (content as Block[])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("\n");
}

/**
 * An edit as diff lines, out of the patch the transcript already recorded.
 *
 * A new file has no hunks — the whole thing is the change — so it is written
 * out as one, which is what makes a Write render like an Edit rather than like
 * a blob of JSON.
 */
function patchLines(result: Record<string, unknown>): string[] {
  const hunks = result.structuredPatch;
  if (!Array.isArray(hunks)) return [];
  if (hunks.length) {
    return (hunks as Hunk[]).flatMap((h) => [
      `@@ -${h.oldStart ?? 0},${h.oldLines ?? 0} +${h.newStart ?? 0},${h.newLines ?? 0} @@`,
      ...(Array.isArray(h.lines) ? h.lines : []),
    ]);
  }
  const content = result.content;
  if (typeof content !== "string" || !content) return [];
  const lines = content.split("\n");
  return [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
}

/**
 * A call's arguments, as the CLI would show them.
 *
 * A command is the whole story and reads as itself; a lone argument is a path
 * or a pattern and reads better bare than wrapped in braces. Everything else
 * gets its JSON, because guessing which of five arguments mattered is how you
 * end up hiding the one that did.
 */
function shownInput(input: Record<string, unknown> | undefined, hasPatch: boolean): string {
  if (!input) return "";
  // With a diff to draw, the arguments are just noise: the old and new strings
  // are the diff, spelled out twice.
  if (hasPatch && typeof input.file_path === "string") return input.file_path;
  if (typeof input.command === "string") return input.command;
  const keys = Object.keys(input);
  if (keys.length === 1 && typeof input[keys[0]] === "string") return input[keys[0]] as string;
  return JSON.stringify(input, null, 2);
}

/** What a tool returned, as the one string worth reading of it. */
function resultText(result: unknown, fallback: string): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return fallback;
  const r = result as Record<string, unknown>;
  // A file that came back as a picture. The bytes have their own route; saying
  // so beats printing a megabyte of base64 or an empty pane.
  const file = r.file as Record<string, unknown> | undefined;
  if (file && typeof file.base64 === "string") return "(an image)";
  if (file && typeof file.content === "string") return file.content;
  if (typeof r.stdout === "string" || typeof r.stderr === "string") {
    const out = typeof r.stdout === "string" ? r.stdout : "";
    const err = typeof r.stderr === "string" ? r.stderr : "";
    return err ? `${out}${out ? "\n" : ""}${err}` : out;
  }
  return JSON.stringify(r, null, 2);
}

/**
 * One call, opened.
 *
 * The window is the one the caller is already displaying, so the reference is
 * inside it by construction — a client can only offer to open a chip it was
 * given. A reference that is not found is not an error and does not say whether
 * it ever existed; it is simply nothing to show.
 */
export function findDetail(text: string, ref: string): ChatDetail {
  let name = "";
  let input: Record<string, unknown> | undefined;
  let found = false;
  let result: unknown = null;
  let blockText = "";
  let failed = false;

  for (const line of text.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    if (entry.isSidechain) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Block[]) {
      if (b?.type === "tool_use" && b.id === ref && typeof b.name === "string") {
        found = true;
        name = b.name;
        input = b.input;
      } else if (b?.type === "tool_result" && b.tool_use_id === ref) {
        if (b.is_error) failed = true;
        result = entry.toolUseResult ?? null;
        blockText = resultBlockText(b);
      }
    }
  }
  if (!found) return { kind: "none" };

  // A plan is prose to be read at length, not a call to be inspected: it is the
  // one thing here that comes back as itself.
  if (name === "ExitPlanMode" && typeof input?.plan === "string") {
    return { kind: "plan", markdown: input.plan.slice(0, MAX_DETAIL_CHARS) };
  }

  const patch =
    result && typeof result === "object" ? patchLines(result as Record<string, unknown>) : [];
  const shown = shownInput(input, patch.length > 0);
  const output = resultText(result, blockText);
  const capped = shown.length > MAX_DETAIL_CHARS || output.length > MAX_DETAIL_CHARS;
  return {
    kind: "tool",
    name,
    input: shown.slice(0, MAX_DETAIL_CHARS),
    output: output.slice(0, MAX_DETAIL_CHARS),
    patch,
    failed,
    truncated: capped,
  };
}

/** One call out of a transcript's tail, or nothing when it is not in it. */
export async function readDetail(
  file: string | null,
  ref: string,
  bytes?: number,
): Promise<ChatDetail> {
  if (!file) return { kind: "none" };
  try {
    const window = await tail(file, Math.min(bytes ?? DEFAULT_WINDOW, MAX_WINDOW));
    return findDetail(window.text, ref);
  } catch {
    return { kind: "none" };
  }
}
