import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AssistantEntry,
  AssistantSearchHit,
  AssistantThread,
  CouncilMember,
} from "../../shared/api.js";
import { memberPrompt, systemPrompt, unattendedPrompt } from "./assistant-persona.js";
import { consumeChunk, finishStream, newStreamState } from "./assistant-stream.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { CHAIR_ID, chair, getMember, listMembers } from "./council-store.js";
import { env } from "./env.js";
import { inject as injectMemory, renderForMember } from "./memory-store.js";
import { agentEnv, readAssistantConfig } from "./settings-store.js";

/**
 * The assistant: the one agent that is not a tmux session.
 *
 * Every other agent here renders its own terminal UI and tmux owns its
 * lifetime, which is what keeps this app small. The assistant cannot work that
 * way, because a chat needs message boundaries and a full-screen TUI's output
 * has none — only frames of a canvas being repainted. So it runs headless
 * (`claude -p --output-format stream-json`) as a process this module owns, and
 * the turns are stored rather than scraped.
 *
 * What it keeps from the session model: the conversation lives in $HOME on the
 * volume exactly as an interactive one does, and verksted mints the id rather
 * than parsing it out, so `claude --resume <id>` in a terminal picks up the
 * same thread. The chat is a different window onto it, not a different agent.
 */

/**
 * What anyone here may do, in two halves.
 *
 * `allowed` is an auto-approve list, not a restriction — anything left off it
 * still exists and, under `--permission-mode auto`, is still up to a classifier.
 * So the tools worth regretting are denied outright. What remains is: read the
 * repos, read the web, and act through the verksted server, whose every
 * endpoint is one the app already validates.
 *
 * Two halves rather than one list because an advisor's own file decides whether
 * it gets the second. The web tools were denied outright until asked for, and
 * the reason is still true: read access to repos that contain .env files, plus
 * fetch, is the shape a prompt injection needs to become exfiltration — and the
 * harvester this is being built towards will eventually read text neither of us
 * wrote. What changed is that reading the web is now part of the chair's job.
 * Nothing here defends against that; what limits it is that no participant can
 * run a shell, so a page that talks one into something still has to go through
 * tools whose every effect is visible in the UI. An advisor with no reason to
 * read a page is not given the half that could carry one back out.
 */
const BUILTIN_READ = ["Read", "Grep", "Glob"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
/**
 * The same, for a turn nobody is reading.
 *
 * The web goes, and knowingly. Fetching a page is how a prompt injection
 * becomes exfiltration, and the only thing standing between the two today is
 * that a person is looking at the reply — which is exactly what an unattended
 * turn does not have. A briefing reads the bench, and the bench is local.
 *
 * The verksted tools are cut in the MCP server rather than here, because an
 * allow list is auto-approval and a deny list of tool names is a thing this
 * repo would have to maintain forever. Under VK_UNATTENDED the server does not
 * offer the ones that change anything, so they do not exist to be approved.
 */
const UNATTENDED_ALLOWED_TOOLS = ["Read", "Grep", "Glob", "mcp__verksted"];
/**
 * Naming the built-ins that exist at all is a stronger statement than the allow
 * list: a tool not named is not present to be approved.
 *
 * It is also the single biggest thing that made the assistant feel slow. With
 * the full built-in set available, the CLI defers the tool schemas and the
 * model has to call ToolSearch to find the verksted ones first — an entire
 * extra round trip, on every turn, before it can even look at the workbench.
 * Naming a short list removes it: measured over the same question, 18.5s with
 * the full set against a steady 5s with this, and no ToolSearch call at all.
 * The same argument applies again to an advisor's verksted tools, which is part
 * of why VK_TOOLS is worth the trouble rather than only being a safety line.
 */
const UNATTENDED_BUILTIN_TOOLS = ["Read", "Grep", "Glob"];
const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task"];
const UNATTENDED_DENIED_TOOLS = [...DENIED_TOOLS, "WebFetch", "WebSearch"];

/** Where the MCP server the assistant acts through lives inside the image. */
function mcpConfig(unattended: boolean, tools: string[] | null, member: string | null) {
  return {
    mcpServers: {
      verksted: {
        command: "node",
        args: ["/etc/verksted/verksted-mcp.mjs"],
        env: {
          VK_API: `http://127.0.0.1:${env.PORT}`,
          // Read by the server itself, which then offers only the tools that
          // change nothing. The list lives next to the tool definitions, so
          // adding a tool means deciding there whether it may run unwatched.
          ...(unattended ? { VK_UNATTENDED: "1" } : {}),
          // The same trick, per advisor: the server offers only these, so a
          // tool a member may not use is absent from tools/list rather than
          // merely left off an allow list. --allowed-tools can only name the
          // whole server (`mcp__verksted`), so this is the one place where a
          // member's tools can actually be narrowed.
          ...(tools ? { VK_TOOLS: tools.join(",") } : {}),
          // Whose memory `remember` writes. From the environment rather than a
          // tool argument, so nothing the model says can change it — an advisor
          // cannot write into the bench's memory, or another advisor's, by
          // naming one.
          ...(member ? { VK_MEMBER: member } : {}),
        },
      },
    },
  };
}

/**
 * Written per speaker, atomically.
 *
 * Two members starting at the same moment would otherwise write the same path
 * while the other's CLI is reading it, which is a torn read of a config that
 * decides what a model may do.
 */
async function ensureMcpConfig(o: {
  id: string;
  unattended: boolean;
  tools: string[] | null;
}): Promise<string> {
  const isChair = o.id === CHAIR_ID;
  const name = o.unattended ? "mcp-unattended" : isChair ? "mcp" : `mcp-${o.id}`;
  const file = path.join(env.ASSISTANT_DIR, `${name}.json`);
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  await writeJsonAtomic(file, mcpConfig(o.unattended, o.tools, isChair ? null : o.id));
  return file;
}

/** Where the active conversation id is remembered across restarts. */
function currentPath(): string {
  return path.join(env.ASSISTANT_DIR, "current");
}

/** Where attached images land, outside any repo and readable by the agent. */
export function uploadsDir(): string {
  return path.join(env.ASSISTANT_DIR, "uploads");
}

/**
 * Where a conversation's entries are mirrored.
 *
 * Unattended threads go in a subdirectory, and it is the same trick the review
 * queue uses: `search` reads `*.jsonl` at the top level, and a subdirectory is
 * not one. Without it, a nightly briefing and a nightly harvest would add some
 * seven hundred threads a year to the set recall searches, all of them the
 * machine talking to itself — recall is for conversations you had, and it reads
 * every file in the directory on every call.
 *
 * This is only verksted's copy. Claude keeps its own under $HOME either way, so
 * `claude --resume <id>` still opens a briefing exactly as before.
 */
function threadPath(conversationId: string, unattended = false): string {
  return path.join(env.ASSISTANT_DIR, unattended ? "unattended" : "", `${conversationId}.jsonl`);
}

/** Conversation ids are uuids we generate; nothing else may name a file here. */
const CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Search the conversations that are not the current one.
 *
 * Every thread ever started is on the volume, and until now the only way back
 * into one was to know its id. This is how "what did we decide about the Kargo
 * promotion" is answerable without carrying a forty-turn thread forward: start
 * a new one and let it look the old one up.
 *
 * The current conversation is deliberately excluded — it is already in the
 * model's context, so a hit there would spend a result slot on something it can
 * read by scrolling up.
 *
 * Substring matching, all words required, no index. The store is a few hundred
 * kilobytes of text on a volume this pod owns; anything cleverer would be a
 * database, which is the thing this app is built not to have.
 */
export async function search(query: string, limit = 8): Promise<AssistantSearchHit[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const current = await currentConversation();
  const files = await fs.readdir(env.ASSISTANT_DIR).catch(() => []);
  const hits: AssistantSearchHit[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const conversationId = file.slice(0, -6);
    if (!CONV_RE.test(conversationId) || conversationId === current) continue;
    for (const entry of await readEntries(conversationId)) {
      const text = entry.text.toLowerCase();
      if (!words.every((w) => text.includes(w))) continue;
      hits.push({
        conversationId,
        at: entry.at,
        role: entry.role,
        text: around(entry.text, entry.text.toLowerCase().indexOf(words[0])),
      });
    }
  }
  return hits.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

/**
 * The matching sentence rather than the whole turn: a hit is re-sent with every
 * later turn of the conversation that asked for it, so a long answer quoted in
 * full is paid for repeatedly.
 */
function around(text: string, at: number, before = 60, after = 260): string {
  const from = Math.max(0, at - before);
  const to = Math.min(text.length, at + after);
  const cut = text
    .slice(from, to)
    .replace(/\s*\n\s*/g, " ")
    .trim();
  return `${from > 0 ? "…" : ""}${cut}${to < text.length ? "…" : ""}`;
}

/**
 * Where each advisor's own claude conversation is remembered for this thread.
 *
 * A member resumes its own conversation rather than sharing the chair's: the
 * transcript on this side is one meeting record, but on claude's side four
 * agents each have their own history, and mixing them would put every advisor's
 * answer into every other advisor's context.
 *
 * Per thread rather than per member for good, because a thread per member would
 * grow without bound — the same argument this file already makes for an
 * unattended run. Starting a new thread resets the whole council, which is the
 * model the chat already has.
 *
 * Not a `.jsonl`, so `search` at the top level never reads it as a conversation.
 */
function participantsPath(threadId: string): string {
  return path.join(env.ASSISTANT_DIR, `${threadId}.participants.json`);
}

async function readParticipants(threadId: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(participantsPath(threadId), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

/**
 * The conversation this member speaks in, within this thread, minting one on
 * first use. Returns whether it already existed, which is what decides
 * --resume against --session-id: getting that the wrong way round either loses
 * the thread or fails outright.
 *
 * Serialised, because a meeting allocates for every advisor at once and this is
 * a read-modify-write on one file: unchained, two advisors starting together
 * both read the same state and the second write drops the first one's id. The
 * advisor whose id was lost then starts a fresh conversation on its next turn
 * and quietly forgets everything it said — a bug with no error in it, which is
 * the kind this file already serialises its appends against.
 */
let participantWrites: Promise<unknown> = Promise.resolve();

function participant(
  threadId: string,
  memberId: string,
): Promise<{ conversationId: string; resume: boolean }> {
  const next = participantWrites.then(() => allocate(threadId, memberId));
  participantWrites = next.catch(() => {});
  return next;
}

async function allocate(
  threadId: string,
  memberId: string,
): Promise<{ conversationId: string; resume: boolean }> {
  const all = await readParticipants(threadId);
  const existing = all[memberId];
  if (existing && CONV_RE.test(existing)) return { conversationId: existing, resume: true };
  const conversationId = randomUUID();
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  await writeJsonAtomic(participantsPath(threadId), { ...all, [memberId]: conversationId });
  return { conversationId, resume: false };
}

/**
 * Turns in flight, keyed by thread and speaker.
 *
 * A registry rather than the single slot this used to be, because a meeting is
 * several processes at once. Held in memory only: a pod restart mid-turn should
 * come back idle with the thread intact, not stuck thinking forever.
 */
const running = new Map<string, { threadId: string; member: string; child: Child | null }>();

type Child = ReturnType<typeof spawn>;

const runKey = (threadId: string, member: string) => `${threadId}\u0000${member}`;

/**
 * Whether a chat turn is in flight at all, and which thread it is in.
 *
 * Separate from the registry, and set on the very first line of `send` before
 * anything is awaited, because two things it cannot answer would otherwise get
 * through. A meeting is several processes in sequence, so between the chair's
 * turn and the advisors starting nothing is spawned and the registry is empty.
 * And a guard placed after an await is not a guard: the thread id is read from
 * disk, so both of two concurrent posts would get past a check that came after
 * it — and, on a bench whose first message this is, would each mint a thread of
 * their own and answer in different conversations.
 */
let chatTurn = false;
let chatThread: string | null = null;

/**
 * Threads whose turn was stopped.
 *
 * Stopping kills the processes that exist, and a meeting's later stages have
 * not been spawned yet — so without this, pressing stop mid-meeting still pays
 * for the closing turn. Cleared when the next turn starts.
 */
const cancelled = new Set<string>();

/** Whether anything at all is in flight in this thread. */
function busy(threadId: string): boolean {
  if (chatTurn) return true;
  for (const r of running.values()) if (r.threadId === threadId) return true;
  return false;
}

/** The members, not the chair, with a turn in flight right now. */
function speakingIn(threadId: string): string[] {
  const ids: string[] = [];
  for (const r of running.values()) {
    if (r.threadId === threadId && r.member !== CHAIR_ID) ids.push(r.member);
  }
  return ids;
}

/**
 * The same for an unattended turn, kept apart on purpose: a schedule firing
 * must not refuse the person typing, and must not be refused by them. One of
 * each may be in flight, and never two of either. A schedule runs the chair
 * alone and convenes nobody, so one boolean is still the whole story.
 */
let unattendedRunning = false;

type Listener = (thread: AssistantThread) => void;
const listeners = new Set<Listener>();

/** Subscribe to thread changes; returns the unsubscribe. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Push the thread to every socket, at most ten times a second.
 *
 * Coalesced because a meeting has several processes announcing at once and each
 * announcement is the whole thread: without this, four streams of token deltas
 * become four times the frames, every one of them a few kilobytes, to a phone
 * on the other end of a tunnel. The trailing edge is what matters — the last
 * state is the true one — so a pending announcement is simply replaced.
 */
let announceTimer: NodeJS.Timeout | null = null;
let pendingLive = "";
const ANNOUNCE_MS = 100;

async function push(live: string): Promise<void> {
  const thread = { ...(await readThread()), live };
  for (const fn of listeners) fn(thread);
}

function announce(live = ""): void {
  if (!listeners.size) return;
  pendingLive = live;
  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    announceTimer = null;
    void push(pendingLive);
  }, ANNOUNCE_MS);
  // A pod shutting down should not be held open by this.
  announceTimer.unref?.();
}

/**
 * A mint in flight, so concurrent callers agree on one conversation.
 *
 * The first message on a fresh bench and the poll watching for its answer both
 * find no file and both would mint: the turn would then write to one thread
 * while the screen read another, and the first exchange would never appear.
 * Nothing about that is particular to a test — the screens read this on a timer
 * while a turn is running.
 */
let minting: Promise<string> | null = null;

/** The active conversation id, minting and recording one on first use. */
export async function currentConversation(): Promise<string> {
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  try {
    const stored = (await fs.readFile(currentPath(), "utf8")).trim();
    if (CONV_RE.test(stored)) return stored;
  } catch {
    // No conversation yet, or the file is unreadable: start a fresh one rather
    // than failing. The old thread stays on disk either way.
  }
  minting ??= mintConversation().finally(() => {
    minting = null;
  });
  return minting;
}

async function mintConversation(): Promise<string> {
  const id = randomUUID();
  // Atomic, because a reader landing mid-write sees an empty file, decides
  // there is no conversation, and mints one of its own.
  await writeTextAtomic(currentPath(), id);
  return id;
}

/** Abandon the current thread and start a new one. The old file is kept. */
export async function newConversation(): Promise<string> {
  if (busy(await currentConversation())) throw new Error("a turn is still running");
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  const id = randomUUID();
  await writeTextAtomic(currentPath(), id);
  announce();
  return id;
}

async function readEntries(conversationId: string, unattended = false): Promise<AssistantEntry[]> {
  try {
    const raw = await fs.readFile(threadPath(conversationId, unattended), "utf8");
    const entries: AssistantEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as AssistantEntry);
      } catch {
        // One corrupt line loses one turn, not the whole conversation.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Append, because a thread is only ever added to. Whole-file rewrites would put
 * every turn ever said at risk of a truncated write; a torn append costs the
 * one line being written, and readEntries skips it.
 */
async function append(
  conversationId: string,
  entry: Omit<AssistantEntry, "id" | "at">,
  unattended = false,
): Promise<AssistantEntry> {
  const full: AssistantEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
  await appendEntry(conversationId, full, unattended);
  return full;
}

/** The same, for an entry already stamped — a member's turn builds its own. */
async function appendEntry(
  conversationId: string,
  entry: AssistantEntry,
  unattended = false,
): Promise<AssistantEntry> {
  const file = threadPath(conversationId, unattended);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`);
  return entry;
}

export async function readThread(): Promise<AssistantThread> {
  const conversationId = await currentConversation();
  const speaking = speakingIn(conversationId);
  return {
    conversationId,
    status: busy(conversationId) ? "thinking" : "idle",
    entries: await readEntries(conversationId),
    ...(speaking.length ? { speaking } : {}),
  };
}

/**
 * Stop everything in flight, if anything is.
 *
 * Everything rather than one thing: mid-meeting, "stop" means stop the meeting.
 * Leaving two advisors running while killing the third would spend the calls
 * and show the answers anyway, which is not what the button says.
 *
 * A run with no child yet is between the registry entry and the spawn. It is
 * still in flight — it is already shown as speaking — so it counts, and the
 * mark on its thread is what kills it the moment it does spawn.
 */
export function stop(): boolean {
  let stopped = false;
  for (const run of running.values()) {
    // Marked whether or not it has a child yet: what has not been spawned is
    // exactly what must not be spawned now.
    cancelled.add(run.threadId);
    run.child?.kill("SIGTERM");
    stopped = true;
  }
  // A meeting between its stages has an empty registry and is still stoppable:
  // the mark is what keeps the stage that has not started from starting.
  if (chatThread) {
    cancelled.add(chatThread);
    stopped = true;
  }
  return stopped;
}

/**
 * Who is speaking, resolved before anything is spawned.
 *
 * `turn` used to read the assistant's config itself, which was fine while there
 * was one voice. With a council the caller decides who is talking, and the
 * runtime below is the same for all of them.
 */
interface Speaker {
  /** Member id, or CHAIR_ID. Names the MCP config and keys the run registry. */
  id: string;
  model: string;
  effort: string;
  systemPrompt: string;
  builtins: string[];
  allowed: string[];
  denied: string[];
  /** Verksted tools this speaker is offered at all; null means every one. */
  tools: string[] | null;
  timeoutMs: number;
}

/**
 * A turn that never comes back would leave the assistant thinking forever, and
 * the one way that happens is a permission prompt with nobody to answer it —
 * headless claude simply waits. Generous, because real work is slow.
 */
const TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Shorter for an advisor, because a meeting waits for the slowest of them and
 * the browser is waiting for the meeting. An advisor reads state and says two
 * sentences; one that has not managed it in five minutes is stuck.
 */
const MEMBER_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * One turn against the CLI.
 *
 * Shared by the chat, by an advisor the chair convened, and by a schedule
 * firing, because they differ in who is talking and where the answer is
 * recorded — not in how a turn is run.
 *
 * Two things are deliberately separated here. `claudeConversationId` is the
 * thread on claude's side, which each participant owns its own of; `sink` is
 * where the answer is recorded on ours, which for a meeting is the one shared
 * transcript. Collapsing them is what made this file single-voiced.
 *
 * The prompt travels as an argv element, never through a shell, so nothing in
 * it can be read as syntax — the same rule the tmux path follows.
 */
async function turn(o: {
  speaker: Speaker;
  claudeConversationId: string;
  /** True to continue that conversation, false to name a new one. */
  resume: boolean;
  prompt: string;
  images: string[];
  unattended: boolean;
  sink: (entry: Omit<AssistantEntry, "id" | "at">) => Promise<AssistantEntry>;
  onSpawn: (child: Child) => void;
  /** Called as entries land, and with the part-written reply between them. */
  onChange: (live?: string) => void;
}): Promise<{ text: string }> {
  const { speaker, images, unattended } = o;

  // Claude reads an image by path with its own Read tool, so an attachment is
  // delivered as a line telling it where to look rather than as bytes on a
  // wire it has no way to receive.
  const withImages = images.length
    ? `${o.prompt}\n\n${images.map((n) => `[image: ${path.join(uploadsDir(), n)}]`).join("\n")}`
    : o.prompt;

  const args = [
    "-p",
    withImages,
    "--output-format",
    "stream-json",
    // stream-json refuses to stream without it.
    "--verbose",
    // Token deltas, so an answer appears as it is written. Without this the
    // first text arrives only when the whole turn is done.
    "--include-partial-messages",
    ...(o.resume ? ["--resume", o.claudeConversationId] : ["--session-id", o.claudeConversationId]),
    // Nobody is watching a headless run to approve a tool call, and a prompt it
    // cannot answer is what the timeout below exists for. Safe here only
    // because the tools worth regretting are denied outright below.
    "--permission-mode",
    "auto",
    "--mcp-config",
    await ensureMcpConfig({ id: speaker.id, unattended, tools: speaker.tools }),
    // Without this, MCP servers configured in $HOME join the ones here — and
    // the allow list only auto-approves, so an unlisted server's tools would
    // still be a classifier's call. The claim that this agent has exactly the
    // verksted tools is only true with it.
    "--strict-mcp-config",
    // Images the user attached; the agent reads them from here by path.
    "--add-dir",
    uploadsDir(),
    // Both default low: this agent summarises state and hands work off, and the
    // model doing the actual engineering is the one in the session it starts.
    "--model",
    speaker.model,
    "--effort",
    speaker.effort,
    "--tools",
    speaker.builtins.join(","),
    "--allowed-tools",
    speaker.allowed.join(" "),
    "--disallowed-tools",
    speaker.denied.join(" "),
    "--append-system-prompt",
    speaker.systemPrompt,
  ];

  const child = spawn("claude", args, {
    cwd: env.REPOS_DIR,
    env: { ...process.env, ...(await agentEnv()) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  o.onSpawn(child);
  o.onChange();

  // Entries are appended and announced the moment they complete, rather than
  // after the process exits: the model produces its first sentence while the
  // tools it wants are still running, and waiting for the exit was the slowest
  // part of a turn by a distance.
  const state = newStreamState();
  let lastLive = "";
  // Whether *this* turn recorded anything. A count of the lines in the thread
  // file would answer a different question now that a meeting has several
  // writers: another advisor finishing would make this one think it spoke.
  let said = false;
  let last = "";
  const record = async (entry: Omit<AssistantEntry, "id" | "at">) => {
    said = true;
    if (entry.role === "assistant" && entry.text.trim()) last = entry.text;
    await o.sink(entry);
  };

  const raw = await new Promise<{ err: string; timedOut: boolean }>((resolve) => {
    let err = "";
    let timedOut = false;
    let queue: Promise<unknown> = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, speaker.timeoutMs);
    child.stdout?.on("data", (d: Buffer) => {
      const entries = consumeChunk(d.toString(), state);
      if (!entries.length) {
        // Nothing completed, but the live text moved: push it so the answer is
        // visible as it lands. Throttled, since deltas arrive per token.
        if (state.live !== lastLive) {
          lastLive = state.live;
          o.onChange(state.live);
        }
        return;
      }
      // Serialised: appends are file writes, and two chunks arriving close
      // together must not interleave inside the thread file.
      queue = queue.then(async () => {
        for (const entry of entries) await record(entry);
        lastLive = "";
        o.onChange();
      });
    });
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const done = () => {
      clearTimeout(timer);
      // Whatever was mid-write when the process ended still has to land.
      void queue.then(() => resolve({ err, timedOut }));
    };
    child.on("error", done);
    child.on("close", done);
  });

  for (const entry of finishStream(state)) await record(entry);
  const error = state.error;

  if (raw.timedOut) {
    const text =
      "That turn ran past its time limit and was stopped. It was most likely waiting on a permission prompt nobody could answer.";
    await o.sink({ role: "assistant", text, tools: [], failed: true });
    return { text: "" };
  }
  if (!said || error) {
    // stderr rather than a generic message: whatever the CLI complained about
    // is the only thing that will explain an empty turn.
    const detail = error ?? raw.err.trim().split("\n").slice(-3).join("\n");
    await o.sink({
      role: "assistant",
      text: detail || "That turn produced nothing.",
      tools: [],
      failed: true,
    });
    return { text: "" };
  }
  return { text: last };
}

/**
 * The tool policy every speaker shares, and the part of it that is not data.
 *
 * A member is a JSON file somebody can edit from their phone. What that file
 * may not contain is a way to run a command: the denied built-ins below hold
 * for the chair and for every advisor, unconditionally, and they are here
 * rather than in council-store.ts so that no form post can reach them.
 */
function policyFor(
  member: CouncilMember,
): Pick<Speaker, "builtins" | "allowed" | "denied" | "tools"> {
  const web = member.web ? ["WebFetch", "WebSearch"] : [];
  return {
    builtins: [...BUILTIN_READ, ...web],
    allowed: [...BUILTIN_READ, ...web, "mcp__verksted"],
    // The chair keeps every tool, so it is offered the server unfiltered; an
    // advisor is offered exactly what its file names.
    tools: member.chair ? null : member.tools,
    denied: member.chair ? DENIED_TOOLS : [...DENIED_TOOLS, ...(member.web ? [] : WEB_TOOLS)],
  };
}

async function speakerFor(member: CouncilMember, prompt: string): Promise<Speaker> {
  return {
    id: member.id,
    model: member.model,
    effort: member.effort,
    systemPrompt: prompt,
    ...policyFor(member),
    timeoutMs: member.chair ? TURN_TIMEOUT_MS : MEMBER_TURN_TIMEOUT_MS,
  };
}

/** The chair, ready to speak, with the roster it may put a question to. */
async function chairSpeaker(): Promise<Speaker> {
  const [config, me, members] = await Promise.all([readAssistantConfig(), chair(), listMembers()]);
  const roster = members
    .filter((m) => m.enabled)
    .map(({ id, name, remit }) => ({ id, name, remit }));
  return speakerFor(me, systemPrompt(config.name, config.instructions, roster));
}

/**
 * How the chair says it wants advisors: the first line of its reply, and
 * nothing else in it.
 *
 * Prose rather than a tool call, and that is a cost decision as much as a
 * simplicity one. A tool costs the round trip that emits it and the round trip
 * that reads its result; a first line costs neither, and this bench already
 * reads a verdict out of a model's own first word — the ok:/attention:/failed:
 * contract is exactly this, and it has held. A first line that does not match
 * is simply an answer, so the failure mode is a meeting that did not happen,
 * which is visible and cheap.
 */
const CONVENE_RE = /^convene:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)\s*$/im;

/** No more than this many advisors in one meeting, whatever the chair asks for. */
export const MAX_CONVENED = 3;

/**
 * Who the chair asked for, filtered to advisors that exist and are enabled.
 *
 * Enforced here rather than trusted to the prompt: a ceiling a model is merely
 * asked to respect is not a ceiling, and this one is what stands between a
 * question and an unbounded number of model calls.
 */
async function convened(text: string): Promise<CouncilMember[]> {
  const line = text.trim().split("\n")[0] ?? "";
  const match = CONVENE_RE.exec(line);
  if (!match) return [];
  const ids = [...new Set(match[1].split(",").map((id) => id.trim()))];
  const members: CouncilMember[] = [];
  for (const id of ids) {
    if (members.length >= MAX_CONVENED) break;
    if (id === CHAIR_ID) continue;
    const member = await getMember(id);
    if (member && member.enabled) members.push(member);
  }
  return members;
}

/**
 * Who is addressed directly, if anyone: a leading `@id`.
 *
 * The one way past the chair's judgement, for when you already know who you
 * want. Cheaper than a meeting by every measure, and it is what makes a wrong
 * routing call something you can work around rather than argue with.
 */
async function addressed(prompt: string): Promise<{ member: CouncilMember; rest: string } | null> {
  const match = /^@([a-z][a-z0-9-]{0,31})\b\s*([\s\S]*)$/.exec(prompt.trim());
  if (!match) return null;
  const member = await getMember(match[1]);
  if (!member || !member.enabled || member.chair) return null;
  const rest = match[2].trim();
  return rest ? { member, rest } : null;
}

/**
 * Run one participant's turn, recording it into this thread's transcript.
 *
 * The registry entry is taken before the spawn rather than after: a second POST
 * arriving while a process is still starting would otherwise get past the guard.
 */
async function speak(o: {
  threadId: string;
  member: CouncilMember;
  systemPrompt: string;
  prompt: string;
  images?: string[];
  /**
   * Hold back a reply that is only a convene line, instead of recording it.
   *
   * The alternative was to append it and edit the file afterwards, and a whole
   * thread rewritten to fix one line is every turn ever said at risk of a
   * truncated write. Holding one entry costs nothing and keeps this file
   * append-only, which is the property the transcript is built on.
   */
  interceptConvene?: boolean;
}): Promise<{ text: string; held: AssistantEntry | null }> {
  const { threadId, member } = o;
  const key = runKey(threadId, member.id);
  running.set(key, { threadId, member: member.id, child: null });
  let held: AssistantEntry | null = null;
  try {
    const { conversationId, resume } = member.chair
      ? { conversationId: threadId, resume: await chairHasSpoken(threadId) }
      : await participant(threadId, member.id);
    const { text } = await turn({
      speaker: await speakerFor(member, o.systemPrompt),
      claudeConversationId: conversationId,
      resume,
      prompt: o.prompt,
      images: o.images ?? [],
      unattended: false,
      sink: async (entry) => {
        const full: AssistantEntry = {
          ...entry,
          ...(member.chair ? {} : { member: member.id }),
          id: randomUUID(),
          at: new Date().toISOString(),
        };
        if (o.interceptConvene && !held && full.role === "assistant" && isConveneLine(full.text)) {
          held = full;
          return full;
        }
        await appendEntry(threadId, full);
        return full;
      },
      onSpawn: (child) => {
        const run = running.get(key);
        if (run) run.child = child;
        // Stop was pressed while this one was still getting ready: there was no
        // process to signal then, so it is signalled now rather than left to
        // run to completion and charge for the answer nobody is waiting for.
        if (cancelled.has(threadId)) child.kill("SIGTERM");
      },
      // Only the chair streams its tokens: three advisors writing at once onto a
      // phone is noise, and a chip saying who is speaking carries the same
      // information for none of the traffic.
      onChange: (live) => announce(member.chair ? live : ""),
    });
    return { text, held };
  } finally {
    running.delete(key);
    announce();
  }
}

/** Whether a reply is nothing but a request for advisors. */
function isConveneLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.split("\n").length === 1 && CONVENE_RE.test(trimmed);
}

/**
 * Whether the chair has ever spoken in this thread.
 *
 * Per author rather than "does the transcript have entries", because a thread
 * whose first turn was addressed to an advisor has entries the chair's own
 * conversation knows nothing about — passing --resume for a claude session that
 * was never created fails the turn outright.
 */
async function chairHasSpoken(threadId: string): Promise<boolean> {
  const entries = await readEntries(threadId);
  return entries.some((e) => e.role === "assistant" && !e.member);
}

/**
 * What the chair is handed once the advisors have answered.
 *
 * Trimmed per answer, because this lands in the chair's own conversation and is
 * re-sent with every later turn of it. An advisor asked for two or three
 * sentences and given a cap is an advisor whose cost is bounded even when it
 * ignores the first half of that.
 */
const MAX_ANSWER = 1_200;

function briefing(question: string, answers: { name: string; text: string }[]): string {
  return [
    "The council answered. Now give the person the answer.",
    "",
    `They asked: ${question}`,
    "",
    ...answers.map((a) => `${a.name}: ${a.text.slice(0, MAX_ANSWER)}`),
    "",
    "Say what it means and what to do, in two or three sentences. Do not repeat",
    "their answers back; they are on the screen above yours. Do not convene",
    "anyone: this is the last word on this question.",
  ].join("\n");
}

/**
 * Run one turn of the chat: record what was asked, ask claude, record what came
 * back.
 *
 * Three shapes, and which one runs is decided by what was typed and by what the
 * chair says first:
 *
 * - `@michael ...` goes straight to that advisor. One call, no chair.
 * - the chair answers. One turn, exactly as before the council existed.
 * - the chair opens with `convene: ...`, the advisors named answer in parallel,
 *   and the chair is asked once more with what they said.
 */
export async function send(prompt: string, images: string[] = []): Promise<AssistantThread> {
  // Taken before anything is awaited, which is the whole of why it is a plain
  // flag: everything below this line yields, and a guard that yields first is
  // one two requests walk through together.
  if (chatTurn) throw new Error("a turn is still running");
  chatTurn = true;

  let threadId = "";
  try {
    threadId = await currentConversation();
    chatThread = threadId;
    cancelled.delete(threadId);

    await appendEntry(threadId, {
      role: "user",
      text: prompt,
      tools: [],
      images,
      id: randomUUID(),
      at: new Date().toISOString(),
    });
    announce();

    const direct = await addressed(prompt);
    if (direct) {
      await speak({
        threadId,
        member: direct.member,
        systemPrompt: await memberSystemPrompt(direct.member),
        prompt: direct.rest,
        images,
      });
    } else {
      await runChair(threadId, prompt, images);
    }
  } finally {
    chatTurn = false;
    chatThread = null;
    // Whatever happened, nothing should be left marked as speaking.
    for (const key of [...running.keys()]) {
      if (running.get(key)?.threadId === threadId) running.delete(key);
    }
  }

  // The turn may have written or deleted a memory file directly, so what every
  // other session is told is rebuilt from the directory rather than from a
  // callback the agent would have had to remember to make. Once per turn, not
  // once per advisor.
  await injectMemory();

  const thread = await readThread();
  for (const fn of listeners) fn(thread);
  return thread;
}

/** The chair's turn, and the meeting it may call. */
async function runChair(threadId: string, prompt: string, images: string[]): Promise<void> {
  const me = await chair();
  const speakerPrompt = (await chairSpeaker()).systemPrompt;

  const { held } = await speak({
    threadId,
    member: me,
    systemPrompt: speakerPrompt,
    prompt,
    images,
    interceptConvene: true,
  });
  if (!held) return;

  if (cancelled.has(threadId)) return;

  const called = await convened(held.text);
  if (!called.length) {
    // It opened with something shaped like a convene line but named nobody who
    // exists. That is an answer, however odd, and swallowing it would leave the
    // turn silent — so it lands as written.
    await appendEntry(threadId, held);
    announce();
    return;
  }

  // The line itself is an instruction to this code and reads as noise in a
  // conversation; that three advisors were asked is the thing worth seeing, and
  // it is what makes a wrong routing call visible rather than silent. Whatever
  // tools the chair used to decide stay on the entry: they were the work.
  await appendEntry(threadId, {
    ...held,
    text: "",
    tools: [...held.tools, { name: "convene", detail: called.map((m) => m.name).join(", ") }],
  });
  announce();

  const answers = await Promise.all(
    called.map(async (member) => {
      const said = await speak({
        threadId,
        member,
        systemPrompt: await memberSystemPrompt(member),
        prompt,
      });
      return { name: member.name, text: said.text };
    }),
  );

  // Nothing was stopped if the advisors were already answering when the button
  // was pressed, but the closing turn has not been paid for yet, and it is the
  // one thing still avoidable.
  if (cancelled.has(threadId)) return;

  await speak({
    threadId,
    member: me,
    systemPrompt: speakerPrompt,
    prompt: briefing(
      prompt,
      answers.filter((a) => a.text.trim()),
    ),
  });
}

/** An advisor's prompt, with the standing orders the whole bench is under. */
async function memberSystemPrompt(member: CouncilMember): Promise<string> {
  const config = await readAssistantConfig();
  return memberPrompt(member, config.instructions, await renderForMember(member.id));
}

/**
 * A turn nobody asked for and nobody is reading: a schedule fired.
 *
 * Three decisions are baked in here, and they are the ones that were blocking
 * this from existing at all.
 *
 * It gets a **fresh conversation every run**. Sharing the chat would mutate a
 * thread the user is reading and re-send it every morning; keeping one thread
 * per schedule would grow without bound, since every turn carries the whole
 * history. A briefing is a standing question with no yesterday in it, so it
 * costs one prompt. The thread still lands on the volume under its own id, so
 * `claude --resume <id>` opens exactly what it did.
 *
 * It runs **beside** the chat rather than in front of it: its own guard, so a
 * schedule firing while you are typing does not refuse you and is not refused.
 * At most one of each, which is the ceiling worth having.
 *
 * And it may **read and notify, nothing else** — see the tool lists above. It
 * convenes nobody: the chair alone answers a briefing, because a schedule that
 * held a four-way meeting every morning would spend four calls on a question
 * whose usual answer is "ok: nothing needs you", and the daily ceiling counts
 * turns rather than meetings.
 */
export async function runUnattended(
  prompt: string,
  memberId = "",
  mayConvene = false,
): Promise<{ text: string; failed: boolean; turns: number }> {
  if (unattendedRunning) throw new Error("an unattended turn is still running");
  const conversationId = randomUUID();
  const config = await readAssistantConfig();
  const roster = mayConvene && !memberId ? (await listMembers()).filter((m) => m.enabled) : [];
  // A named advisor answers in its own voice, on its own subject, with its own
  // tools narrowed further by the unattended filter. One of them, never a
  // meeting: the daily ceiling counts turns, and a briefing that convened three
  // advisors would quietly be four calls against a budget that counted one.
  const member = memberId ? await getMember(memberId) : null;
  const speaker: Speaker =
    member && !member.chair
      ? {
          id: member.id,
          model: member.model,
          effort: member.effort,
          systemPrompt: memberPrompt(
            member,
            config.instructions,
            await renderForMember(member.id),
            true,
          ),
          builtins: UNATTENDED_BUILTIN_TOOLS,
          allowed: UNATTENDED_ALLOWED_TOOLS,
          denied: UNATTENDED_DENIED_TOOLS,
          tools: member.tools,
          timeoutMs: TURN_TIMEOUT_MS,
        }
      : {
          id: CHAIR_ID,
          model: config.model,
          effort: config.effort,
          systemPrompt: unattendedPrompt(
            config.name,
            config.instructions,
            roster.map(({ id, name, remit }) => ({ id, name, remit })),
          ),
          builtins: UNATTENDED_BUILTIN_TOOLS,
          allowed: UNATTENDED_ALLOWED_TOOLS,
          denied: UNATTENDED_DENIED_TOOLS,
          // The MCP server cuts the mutating tools itself under VK_UNATTENDED,
          // so there is nothing more to name here.
          tools: null,
          timeoutMs: TURN_TIMEOUT_MS,
        };
  unattendedRunning = true;
  let turns = 1;
  try {
    // Set from inside the sink below, which TypeScript cannot see through.
    const heldBox: { entry: AssistantEntry | null } = { entry: null };
    await turn({
      speaker,
      claudeConversationId: conversationId,
      resume: false,
      prompt,
      images: [],
      unattended: true,
      sink: async (entry) => {
        const full: AssistantEntry = {
          ...entry,
          id: randomUUID(),
          at: new Date().toISOString(),
        };
        if (
          roster.length &&
          !heldBox.entry &&
          full.role === "assistant" &&
          isConveneLine(full.text)
        ) {
          heldBox.entry = full;
          return full;
        }
        return appendEntry(conversationId, full, true);
      },
      onSpawn: () => {},
      onChange: () => {},
    });

    const held = heldBox.entry;
    const called = held ? await convened(held.text) : [];
    if (held && !called.length) await appendEntry(conversationId, held, true);
    if (held && called.length) {
      await appendEntry(
        conversationId,
        {
          ...held,
          text: "",
          tools: [...held.tools, { name: "convene", detail: called.map((m) => m.name).join(", ") }],
        },
        true,
      );
      const answers = await Promise.all(
        called.map(async (member) => {
          const said = await unattendedMemberTurn(conversationId, member, prompt, config);
          return { name: member.name, text: said };
        }),
      );
      turns += called.length + 1;
      await turn({
        speaker,
        claudeConversationId: conversationId,
        resume: true,
        prompt: briefing(
          prompt,
          answers.filter((a) => a.text.trim()),
        ),
        images: [],
        unattended: true,
        sink: (entry) => append(conversationId, entry, true),
        onSpawn: () => {},
        onChange: () => {},
      });
    }
  } finally {
    unattendedRunning = false;
  }
  // `failed` is only written on a turn that went wrong, so its absence means
  // the turn was fine — and no entry at all means it produced nothing.
  const last = (await readEntries(conversationId, true))
    .filter((e) => e.role === "assistant" && !e.member && e.text.trim())
    .pop();
  return { text: last?.text.trim() ?? "", failed: !last || last.failed === true, turns };
}

/**
 * One advisor answering a briefing nobody asked for.
 *
 * A fresh conversation every time, like the chair's: a schedule has no
 * yesterday in it, and a thread per advisor per schedule would grow forever.
 * Its answer is recorded under its own name so `claude --resume` opens exactly
 * what ran, and returned so the chair can sign off on it.
 */
async function unattendedMemberTurn(
  conversationId: string,
  member: CouncilMember,
  prompt: string,
  config: { instructions: string },
): Promise<string> {
  const own = randomUUID();
  const { text } = await turn({
    speaker: {
      id: member.id,
      model: member.model,
      effort: member.effort,
      systemPrompt: memberPrompt(
        member,
        config.instructions,
        await renderForMember(member.id),
        true,
      ),
      builtins: UNATTENDED_BUILTIN_TOOLS,
      allowed: UNATTENDED_ALLOWED_TOOLS,
      denied: UNATTENDED_DENIED_TOOLS,
      tools: member.tools,
      timeoutMs: MEMBER_TURN_TIMEOUT_MS,
    },
    claudeConversationId: own,
    resume: false,
    prompt,
    images: [],
    unattended: true,
    sink: (entry) =>
      appendEntry(
        conversationId,
        { ...entry, member: member.id, id: randomUUID(), at: new Date().toISOString() },
        true,
      ),
    onSpawn: () => {},
    onChange: () => {},
  });
  return text;
}
