import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantEntry, AssistantSearchHit, AssistantThread } from "../../shared/api.js";
import { systemPrompt, unattendedPrompt } from "./assistant-persona.js";
import { consumeChunk, finishStream, newStreamState } from "./assistant-stream.js";
import { env } from "./env.js";
import { inject as injectMemory } from "./memory-store.js";
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
 * What the assistant may do.
 *
 * `allowed` is an auto-approve list, not a restriction — anything left off it
 * still exists and, under `--permission-mode auto`, is still up to a classifier.
 * So the tools worth regretting are denied outright. What remains is: read the
 * repos, read the web, and act through the verksted server, whose every
 * endpoint is one the app already validates.
 *
 * The web tools were denied here until asked for, and the reason is still true:
 * read access to repos that contain .env files, plus fetch, is the shape a
 * prompt injection needs to become exfiltration — and the harvester this is
 * being built towards will eventually read text neither of us wrote. What
 * changed is that reading the web is now part of the job. Nothing here defends
 * against that; what limits it is that the assistant cannot run a shell, so a
 * page that talks it into something still has to go through tools whose every
 * effect is visible in the UI.
 */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "mcp__verksted"];
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
 * The built-in tools that exist at all, which is a stronger statement than the
 * allow list: a tool not named here is not present to be approved.
 *
 * It is also the single biggest thing that made the assistant feel slow. With
 * the full built-in set available, the CLI defers the tool schemas and the
 * model has to call ToolSearch to find the verksted ones first — an entire
 * extra round trip, on every turn, before it can even look at the workbench.
 * Naming a short list removes it: measured over the same question, 18.5s with
 * the full set against a steady 5s with this, and no ToolSearch call at all.
 */
const BUILTIN_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];
const UNATTENDED_BUILTIN_TOOLS = ["Read", "Grep", "Glob"];
const DENIED_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task"];
const UNATTENDED_DENIED_TOOLS = [...DENIED_TOOLS, "WebFetch", "WebSearch"];

/** Where the MCP server the assistant acts through lives inside the image. */
function mcpConfig(unattended: boolean) {
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
        },
      },
    },
  };
}

async function ensureMcpConfig(unattended: boolean): Promise<string> {
  const file = path.join(env.ASSISTANT_DIR, unattended ? "mcp-unattended.json" : "mcp.json");
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(mcpConfig(unattended), null, 2));
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
 * A turn in flight. Held in memory only: a pod restart mid-turn should come
 * back idle with the thread intact, not stuck thinking forever.
 */
let running: { conversationId: string; child: ReturnType<typeof spawn> | null } | null = null;

/**
 * The same for an unattended turn, kept apart on purpose: a schedule firing
 * must not refuse the person typing, and must not be refused by them. One of
 * each may be in flight, and never two of either.
 */
let unattendedRunning = false;

type Listener = (thread: AssistantThread) => void;
const listeners = new Set<Listener>();

/** Subscribe to thread changes; returns the unsubscribe. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function announce(live = ""): Promise<void> {
  if (!listeners.size) return;
  const thread = { ...(await readThread()), live };
  for (const fn of listeners) fn(thread);
}

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
  const id = randomUUID();
  await fs.writeFile(currentPath(), id);
  return id;
}

/** Abandon the current thread and start a new one. The old file is kept. */
export async function newConversation(): Promise<string> {
  if (running) throw new Error("a turn is still running");
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  const id = randomUUID();
  await fs.writeFile(currentPath(), id);
  await announce();
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
  const file = threadPath(conversationId, unattended);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(full)}\n`);
  return full;
}

export async function readThread(): Promise<AssistantThread> {
  const conversationId = await currentConversation();
  return {
    conversationId,
    status: running ? "thinking" : "idle",
    entries: await readEntries(conversationId),
  };
}

/**
 * A turn that never comes back would leave the assistant thinking forever, and
 * the one way that happens is a permission prompt with nobody to answer it —
 * headless claude simply waits. Generous, because real work is slow.
 */
const TURN_TIMEOUT_MS = 10 * 60_000;

/** Stop the turn in flight, if any. */
export function stop(): boolean {
  // No child yet means the turn is between the guard and the spawn, which is a
  // window of milliseconds; there is nothing to signal, so say so.
  if (!running?.child) return false;
  running.child.kill("SIGTERM");
  return true;
}

/**
 * One turn against the CLI, in a given conversation.
 *
 * Shared by the chat and by a schedule firing, because the two differ in what
 * they may do and who is told — not in how a turn is run. `unattended` is the
 * only switch: it narrows the tools and changes what the prompt asks for.
 *
 * The prompt travels as an argv element, never through a shell, so nothing in
 * it can be read as syntax — the same rule the tmux path follows.
 */
async function turn(o: {
  conversationId: string;
  prompt: string;
  images: string[];
  /** True to continue the conversation, false to name a new one. */
  resume: boolean;
  unattended: boolean;
  onSpawn: (child: ReturnType<typeof spawn>) => void;
  /** Called as entries land, and with the part-written reply between them. */
  onChange: (live?: string) => void;
}): Promise<void> {
  const { conversationId, images, unattended } = o;
  // What the thread held before this turn, so "it produced nothing" is a fact
  // rather than a guess about how many entries a turn ought to add.
  const before = (await readEntries(conversationId, unattended)).length;

  // Claude reads an image by path with its own Read tool, so an attachment is
  // delivered as a line telling it where to look rather than as bytes on a
  // wire it has no way to receive.
  const withImages = images.length
    ? `${o.prompt}\n\n${images.map((n) => `[image: ${path.join(uploadsDir(), n)}]`).join("\n")}`
    : o.prompt;

  // --session-id names a new conversation, --resume continues one. Getting this
  // the wrong way round either loses the thread or fails outright, so it keys
  // off whether anything has been said in it before.
  const config = await readAssistantConfig();
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
    ...(o.resume ? ["--resume", conversationId] : ["--session-id", conversationId]),
    // Nobody is watching a headless run to approve a tool call, and a prompt it
    // cannot answer is what the timeout below exists for. Safe here only
    // because the tools worth regretting are denied outright below.
    "--permission-mode",
    "auto",
    "--mcp-config",
    await ensureMcpConfig(unattended),
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
    config.model,
    "--effort",
    config.effort,
    "--tools",
    (unattended ? UNATTENDED_BUILTIN_TOOLS : BUILTIN_TOOLS).join(","),
    "--allowed-tools",
    (unattended ? UNATTENDED_ALLOWED_TOOLS : ALLOWED_TOOLS).join(" "),
    "--disallowed-tools",
    (unattended ? UNATTENDED_DENIED_TOOLS : DENIED_TOOLS).join(" "),
    "--append-system-prompt",
    unattended
      ? unattendedPrompt(config.name, config.instructions)
      : systemPrompt(config.name, config.instructions),
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
  const raw = await new Promise<{ err: string; timedOut: boolean }>((resolve) => {
    let err = "";
    let timedOut = false;
    let queue: Promise<unknown> = Promise.resolve();
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TURN_TIMEOUT_MS);
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
        for (const entry of entries) await append(conversationId, entry, unattended);
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

  for (const entry of finishStream(state)) await append(conversationId, entry, unattended);
  const error = state.error;
  const said = (await readEntries(conversationId, unattended)).length > before;

  if (raw.timedOut) {
    await append(
      conversationId,
      {
        role: "assistant",
        text: "That turn ran past ten minutes and was stopped. It was most likely waiting on a permission prompt nobody could answer.",
        tools: [],
        failed: true,
      },
      unattended,
    );
  } else if (!said || error) {
    // stderr rather than a generic message: whatever the CLI complained about
    // is the only thing that will explain an empty turn.
    const detail = error ?? raw.err.trim().split("\n").slice(-3).join("\n");
    await append(
      conversationId,
      { role: "assistant", text: detail || "That turn produced nothing.", tools: [], failed: true },
      unattended,
    );
  }
}

/**
 * Run one turn of the chat: record what was asked, ask claude, record what came
 * back. Everything the socket shows follows from the entries this appends.
 */
export async function send(prompt: string, images: string[] = []): Promise<AssistantThread> {
  if (running) throw new Error("a turn is still running");
  const conversationId = await currentConversation();
  const resume = (await readEntries(conversationId)).length > 0;

  await append(conversationId, { role: "user", text: prompt, tools: [], images });
  // Held from here rather than from the spawn: a second POST arriving while the
  // process is still starting would otherwise get past the guard above.
  running = { conversationId, child: null };

  try {
    await turn({
      conversationId,
      prompt,
      images,
      resume,
      unattended: false,
      onSpawn: (child) => {
        if (running) running.child = child;
      },
      onChange: (live) => void announce(live),
    });
  } finally {
    running = null;
  }

  // The turn may have written or deleted a memory file directly, so what every
  // other session is told is rebuilt from the directory rather than from a
  // callback the agent would have had to remember to make.
  await injectMemory();

  const thread = await readThread();
  for (const fn of listeners) fn(thread);
  return thread;
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
 * And it may **read and notify, nothing else** — see the tool lists above.
 */
export async function runUnattended(prompt: string): Promise<{ text: string; failed: boolean }> {
  if (unattendedRunning) throw new Error("an unattended turn is still running");
  const conversationId = randomUUID();
  unattendedRunning = true;
  try {
    await turn({
      conversationId,
      prompt,
      images: [],
      resume: false,
      unattended: true,
      onSpawn: () => {},
      onChange: () => {},
    });
  } finally {
    unattendedRunning = false;
  }
  // `failed` is only written on a turn that went wrong, so its absence means
  // the turn was fine — and no entry at all means it produced nothing.
  const last = (await readEntries(conversationId, true))
    .filter((e) => e.role === "assistant")
    .pop();
  return { text: last?.text.trim() ?? "", failed: !last || last.failed === true };
}
