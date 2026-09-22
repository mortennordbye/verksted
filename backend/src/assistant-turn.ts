import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantEntry, SessionUsage } from "../../shared/api.js";
import {
  consumeChunk,
  finishStream,
  newStreamState,
  type Entry as StreamEntry,
  type Shot,
} from "./assistant-stream.js";
import { ASSISTANT_CDP_PORT } from "./browser.js";
import { transcriptPath } from "./claude-home.js";
import { CHAIR_ID } from "./council-store.js";
import { env } from "./env.js";
import * as journal from "./journal-store.js";
import { noteTool } from "./assistant-taint.js";
import {
  ensureMcpConfig,
  holdsHeadroom,
  turnEnv,
  uploadsDir,
  type ToolPolicy,
} from "./assistant-policy.js";

/**
 * One turn of the CLI, and the processes it is.
 *
 * What is here knows nothing of threads, meetings or schedules: who is
 * speaking, what they are asked, and where the answer goes are all the
 * caller's (see `turn`). What it owns is the process — spawning it, reading
 * its stream, timing it out, and ending it with everything it started.
 */

export type Child = ReturnType<typeof spawn>;

/**
 * Pictures a tool returned, written beside the uploads so the chat can show
 * them. Named by the server the way an upload is, so one route serves both and
 * no base64 ever lands in the thread file or on the socket.
 */
async function saveShots(shots: Shot[]): Promise<string[]> {
  await fs.mkdir(uploadsDir(), { recursive: true });
  const names: string[] = [];
  for (const shot of shots) {
    const type = shot.mediaType.split("/")[1];
    const name = `${randomUUID()}.${type === "jpeg" ? "jpg" : type}`;
    await fs.writeFile(path.join(uploadsDir(), name), Buffer.from(shot.data, "base64"));
    names.push(name);
  }
  return names;
}

/**
 * Every CLI this module has out, attended or not.
 *
 * `running` in assistant.ts is what the stop button reads, and it only knows the
 * conversation on screen. This is what the process leaving reads: a turn is its own process
 * group now (see `endTree`), so nothing else would end one on the way out.
 */
const live = new Set<Child>();

/** How long a turn gets to leave on its own before it is made to. */
const KILL_GRACE_MS = 5_000;

/**
 * End a turn and everything it started (A-15).
 *
 * The CLI is not one process: it starts the verksted MCP server, headroom's,
 * and for the chair a browser wrapper, and a signal sent to the CLI's pid alone
 * left those behind, holding their sockets and their memory, once for every
 * turn that timed out or was stopped. The turn is spawned as the leader of its
 * own group, so the negative pid reaches all of it.
 *
 * Asked first, because a CLI that is told to stop writes its transcript out;
 * then told, because the turn this exists for is the one that is not listening.
 * The second signal goes even when the CLI has already exited: what it started
 * may not have.
 */
export function endTree(child: Child): void {
  const pid = child.pid;
  if (pid === undefined) return;
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // Nothing left in the group, which is the outcome being asked for.
    }
  };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS).unref();
}

/**
 * End every turn in flight. For the process leaving; the threads keep what was
 * said. Only the asking half happens then, since the exit does not wait five
 * seconds for the other, and on the pod the container goes with it anyway.
 */
export function stopAll(): void {
  for (const child of live) endTree(child);
}

/**
 * Who is speaking, resolved before anything is spawned.
 *
 * `turn` used to read the assistant's config itself, which was fine while there
 * was one voice. With a council the caller decides who is talking, and the
 * runtime below is the same for all of them.
 */
export interface Speaker extends ToolPolicy {
  /** Member id, or CHAIR_ID. Names the MCP config and keys the run registry. */
  id: string;
  model: string;
  effort: string;
  systemPrompt: string;
  timeoutMs: number;
}

/**
 * A turn that never comes back would leave the assistant thinking forever, and
 * the one way that happens is a permission prompt with nobody to answer it —
 * headless claude simply waits. Generous, because real work is slow.
 *
 * Shorter for an advisor, because a meeting waits for the slowest of them and
 * the browser is waiting for the meeting. An advisor reads state and says two
 * sentences; one that has not managed it in five minutes is stuck.
 */
export const TURN_TIMEOUTS = { chair: 10 * 60_000, member: 5 * 60_000 };

/**
 * The most turns a day gets from somebody who is there (A-26).
 *
 * Not a budget: the person asking is paying for their own question, on their
 * own bench. It is the backstop against the day that runs away — a thread
 * resumed a hundred times with a meeting in every turn, a loop somebody wrote
 * against the API — and it is wide enough that a long day never meets it.
 * Turns rather than messages, for the reason the unattended ceiling gives: a
 * round table is the chair twice and everyone once, so a ceiling that counted
 * messages would let one line be eight calls. In memory like that one, so a
 * restart forgets the day; a backstop that forgives a restart is still one.
 */
let MAX_ATTENDED_PER_DAY = 200;
let attendedDay = "";
let attendedToday = 0;

function attendedCount(): number {
  const day = journal.today();
  if (day !== attendedDay) {
    attendedDay = day;
    attendedToday = 0;
  }
  return attendedToday;
}

/** Why a turn somebody is waiting for would be refused today, or null. */
export function attendedBlocked(): string | null {
  return attendedCount() >= MAX_ATTENDED_PER_DAY
    ? `${MAX_ATTENDED_PER_DAY} turns already ran today; the ceiling resets at midnight`
    : null;
}

/**
 * For tests: two hundred turns is not something a suite can run. The day's
 * count starts again at nothing, since every case before this one in the
 * process has spent some of it. Returns a way back.
 */
export function setAttendedCeiling(n: number): () => void {
  const before = { ceiling: MAX_ATTENDED_PER_DAY, today: attendedCount() };
  MAX_ATTENDED_PER_DAY = n;
  attendedToday = 0;
  return () => {
    MAX_ATTENDED_PER_DAY = before.ceiling;
    attendedToday = before.today;
  };
}

/** For tests: ten minutes is not something a suite can wait out. Returns a way back. */
export function setTurnTimeouts(chairMs: number, memberMs: number): () => void {
  const before = { ...TURN_TIMEOUTS };
  TURN_TIMEOUTS.chair = chairMs;
  TURN_TIMEOUTS.member = memberMs;
  return () => {
    Object.assign(TURN_TIMEOUTS, before);
  };
}

/**
 * The two ways claude refuses a conversation id: asked to resume one it has no
 * transcript of, or to name one it already has. Both were read off the real
 * CLI (2.1.278), and both come before any model call.
 */
const WRONG_FLAG_RE = /No conversation found with session ID|Session ID \S+ is already in use/;

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

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
export async function turn(o: {
  speaker: Speaker;
  claudeConversationId: string;
  prompt: string;
  images: string[];
  unattended: boolean;
  sink: (entry: Omit<AssistantEntry, "id" | "at">) => Promise<AssistantEntry>;
  onSpawn: (child: Child) => void;
  /** Called as entries land, and with the part-written reply between them. */
  onChange: (live?: string) => void;
  /** What the run took, once it has ended and said so. */
  onUsage?: (taken: { usage: SessionUsage; context: number }) => Promise<void>;
}): Promise<{ text: string }> {
  const { speaker, images, unattended } = o;
  // Counted as it starts, not as it is asked for: the message that opens a
  // meeting is one turn here and several by the time the meeting ends.
  if (!unattended) attendedToday = attendedCount() + 1;
  // This run of the CLI, named. Everything the turn reaches carries it, which
  // is what lets a read of something private cost this turn its browser
  // without costing the next one anything (see assistant-taint.ts).
  const turnId = randomUUID();

  // Claude reads an image by path with its own Read tool, so an attachment is
  // delivered as a line telling it where to look rather than as bytes on a
  // wire it has no way to receive.
  const withImages = images.length
    ? `${o.prompt}\n\n${images.map((n) => `[image: ${path.join(uploadsDir(), n)}]`).join("\n")}`
    : o.prompt;

  const mcpConfig = await ensureMcpConfig({
    id: speaker.id,
    unattended,
    tools: speaker.tools,
    turn: turnId,
  });
  const args = (resume: boolean) => [
    "-p",
    withImages,
    "--output-format",
    "stream-json",
    // stream-json refuses to stream without it.
    "--verbose",
    // Token deltas, so an answer appears as it is written. Without this the
    // first text arrives only when the whole turn is done.
    "--include-partial-messages",
    ...(resume ? ["--resume", o.claudeConversationId] : ["--session-id", o.claudeConversationId]),
    // Nobody is watching a headless run to approve a tool call, so what no
    // allow rule covers is refused on the spot. `auto` hands those calls to a
    // classifier instead, and a read outside the repos is one of them.
    "--permission-mode",
    "dontAsk",
    "--mcp-config",
    mcpConfig,
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

  const childEnv = {
    ...(await turnEnv(holdsHeadroom(speaker.id === CHAIR_ID ? null : speaker.id, unattended))),
    // Matches the mcpConfig() browser entry, which only exists for the
    // chair's attended turns — this is the endpoint its wrapper connects to.
    ...(speaker.id === CHAIR_ID && !unattended
      ? { VK_BROWSER_CDP: `http://127.0.0.1:${ASSISTANT_CDP_PORT}` }
      : {}),
    VK_TURN: turnId,
  };

  // Entries are appended and announced the moment they complete, rather than
  // after the process exits: the model produces its first sentence while the
  // tools it wants are still running, and waiting for the exit was the slowest
  // part of a turn by a distance.
  let state = newStreamState((name) => noteTool(turnId, name));
  let lastLive = "";
  // Whether *this* turn recorded anything. A count of the lines in the thread
  // file would answer a different question now that a meeting has several
  // writers: another advisor finishing would make this one think it spoke.
  let said = false;
  let last = "";
  const record = async ({ shots, ...entry }: StreamEntry) => {
    said = true;
    if (entry.role === "assistant" && entry.text.trim()) last = entry.text;
    await o.sink(shots?.length ? { ...entry, images: await saveShots(shots) } : entry);
  };

  const attempt = (resume: boolean) => {
    const child = spawn("claude", args(resume), {
      cwd: env.REPOS_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // The leader of its own process group, so ending the turn ends what the
      // turn started. See `endTree`.
      detached: true,
    });
    live.add(child);
    child.once("close", () => live.delete(child));
    child.once("error", () => live.delete(child));
    // Decoded by the stream, not per chunk. `chunk.toString()` cuts a multi-byte
    // character in half wherever the pipe happens to break, and both halves come
    // back U+FFFD — so an æ, ø or å in a reply was replaced by a pair of question
    // marks, at random, in text that is then stored and read back for ever.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    o.onSpawn(child);
    o.onChange();
    return collect(child);
  };

  const collect = (child: Child) =>
    new Promise<{ err: string; timedOut: boolean }>((resolve) => {
      let err = "";
      let timedOut = false;
      let queue: Promise<unknown> = Promise.resolve();
      const timer = setTimeout(() => {
        timedOut = true;
        endTree(child);
      }, speaker.timeoutMs);
      child.stdout?.on("data", (d: string) => {
        const entries = consumeChunk(d, state);
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
      // Only ever read for its last three lines, and a CLI that is looping on an
      // error would otherwise be kept whole, in memory, for ten minutes.
      child.stderr?.on("data", (d: string) => (err = (err + d).slice(-4_000)));
      const done = () => {
        clearTimeout(timer);
        // Whatever was mid-write when the process ended still has to land.
        void queue.then(() => resolve({ err, timedOut }));
      };
      child.on("error", done);
      child.on("close", done);
    });

  // Which flag is claude's to say, not this app's: the conversation exists once
  // claude has written its transcript, and nothing on this side tracks that. A
  // thread file with a reply in it used to stand in for it, and the two part
  // ways whenever a turn ends between them — a stop on a held convene line, a
  // restart during a first turn, a first turn that failed before claude got as
  // far as a session. From then on every turn of that thread passed the wrong
  // flag and failed, for good.
  const resume = await exists(transcriptPath(env.REPOS_DIR, o.claudeConversationId));
  let raw = await attempt(resume);
  // And where the guess is still wrong, claude says so before it has asked the
  // model anything, so the other flag costs one more spawn and no tokens.
  if (!said && !raw.timedOut && WRONG_FLAG_RE.test(`${state.error ?? ""}\n${raw.err}`)) {
    state = newStreamState((name) => noteTool(turnId, name));
    raw = await attempt(!resume);
  }

  for (const entry of finishStream(state)) await record(entry);
  const error = state.error;
  // A turn that failed or ran out of time still took what it took.
  if (state.usage) await o.onUsage?.({ usage: state.usage, context: state.context });

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
