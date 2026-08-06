import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantEntry, AssistantThread } from "../../shared/api.js";
import { parseStream } from "./assistant-stream.js";
import { env } from "./env.js";
import { agentEnv } from "./settings-store.js";

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

/** Where the active conversation id is remembered across restarts. */
function currentPath(): string {
  return path.join(env.ASSISTANT_DIR, "current");
}

function threadPath(conversationId: string): string {
  return path.join(env.ASSISTANT_DIR, `${conversationId}.jsonl`);
}

/** Conversation ids are uuids we generate; nothing else may name a file here. */
const CONV_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A turn in flight. Held in memory only: a pod restart mid-turn should come
 * back idle with the thread intact, not stuck thinking forever.
 */
let running: { conversationId: string; child: ReturnType<typeof spawn> } | null = null;

type Listener = (thread: AssistantThread) => void;
const listeners = new Set<Listener>();

/** Subscribe to thread changes; returns the unsubscribe. */
export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function announce(): Promise<void> {
  if (!listeners.size) return;
  const thread = await readThread();
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

async function readEntries(conversationId: string): Promise<AssistantEntry[]> {
  try {
    const raw = await fs.readFile(threadPath(conversationId), "utf8");
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
): Promise<AssistantEntry> {
  const full: AssistantEntry = { ...entry, id: randomUUID(), at: new Date().toISOString() };
  await fs.mkdir(env.ASSISTANT_DIR, { recursive: true });
  await fs.appendFile(threadPath(conversationId), `${JSON.stringify(full)}\n`);
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
  if (!running) return false;
  running.child.kill("SIGTERM");
  return true;
}

/**
 * Run one turn: record what was asked, ask claude, record what came back.
 *
 * The prompt travels as an argv element, never through a shell, so nothing in
 * it can be read as syntax — the same rule the tmux path follows.
 */
export async function send(prompt: string): Promise<AssistantThread> {
  if (running) throw new Error("a turn is still running");
  const conversationId = await currentConversation();
  const started = await readEntries(conversationId);

  await append(conversationId, { role: "user", text: prompt, tools: [] });

  // --session-id names a new conversation, --resume continues one. Getting this
  // the wrong way round either loses the thread or fails outright, so it keys
  // off whether anything has been said in it before.
  const args = [
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    // stream-json refuses to stream without it.
    "--verbose",
    ...(started.length ? ["--resume", conversationId] : ["--session-id", conversationId]),
    // Nobody is watching a headless run to approve a tool call, and a prompt it
    // cannot answer is what the timeout below exists for.
    "--permission-mode",
    "auto",
  ];

  const child = spawn("claude", args, {
    cwd: env.REPOS_DIR,
    env: { ...process.env, ...(await agentEnv()) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  running = { conversationId, child };
  void announce();

  const raw = await new Promise<{ out: string; err: string; timedOut: boolean }>((resolve) => {
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TURN_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    const done = () => {
      clearTimeout(timer);
      resolve({ out, err, timedOut });
    };
    child.on("error", done);
    child.on("close", done);
  });

  running = null;

  const { entries, error } = parseStream(raw.out);
  for (const entry of entries) await append(conversationId, entry);

  if (raw.timedOut) {
    await append(conversationId, {
      role: "assistant",
      text: "That turn ran past ten minutes and was stopped. It was most likely waiting on a permission prompt nobody could answer.",
      tools: [],
      failed: true,
    });
  } else if (!entries.length || error) {
    // stderr rather than a generic message: whatever the CLI complained about
    // is the only thing that will explain an empty turn.
    const detail = error ?? raw.err.trim().split("\n").slice(-3).join("\n");
    await append(conversationId, {
      role: "assistant",
      text: detail || "That turn produced nothing.",
      tools: [],
      failed: true,
    });
  }

  const thread = await readThread();
  for (const fn of listeners) fn(thread);
  return thread;
}
