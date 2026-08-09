// Wire types shared between backend and frontend. Types only — no runtime code.

export type AgentName = "claude" | "antigravity" | "codex";

export interface Project {
  name: string;
  branch: string;
  dirty: boolean;
  running: number;
  waiting: number;
  done: number;
  agents: AgentName[];
  lastSessionAt: string | null;
  /** Name of the main repo this project is a linked git worktree of, if any. */
  worktreeOf: string | null;
}

export interface Session {
  id: string;
  project: string;
  agent: AgentName;
  title: string;
  createdAt: string;
  endedAt: string | null;
  status: "running" | "waiting" | "done";
  /**
   * The one-line verdict the agent wrote about its own work, or null when it
   * wrote none. Scheduled runs have always been asked for this; every session
   * is now, so a card can say what the agent concluded rather than only
   * whether its tmux session is still alive.
   */
  report: string | null;
  /** That verdict as one word, falling back to where the session got to. */
  outcome: "ok" | "attention" | "failed" | "running" | "done";
}

/** The last lines a session printed, for answering it without a terminal. */
export interface SessionCapture {
  id: string;
  text: string;
  /** False when the session has ended; text is then empty. */
  live: boolean;
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  modified?: boolean;
  children?: TreeNode[];
}

/**
 * The file tree, plus whether the walk ran out of budget. Without the flag a
 * huge repo came back quietly missing files, which reads as "the file is not
 * there" rather than "the tree stopped early".
 */
export interface Tree {
  nodes: TreeNode[];
  truncated: boolean;
}

export interface FileContent {
  path: string;
  content: string;
  /**
   * Version of the file as read. Send it back as `If-Match` on PUT and the save
   * is rejected with 412 if anything wrote to the file meanwhile — the agent
   * shares this working tree, so that is a normal thing to happen rather than
   * an edge case.
   */
  etag: string;
}

export interface FileDiff {
  path: string;
  /** Unified diff text ("" when there is no change to show). */
  diff: string;
}

/** Where a phone upload landed, repo-relative — the path to hand to the agent. */
export interface UploadedFile {
  path: string;
}

export interface ListeningPort {
  port: number;
  /** Process or container name, best effort. */
  process: string;
  /** URL reachable from the session browser. */
  url: string;
}

export interface PodFacts {
  /** Bytes on the data volume. */
  diskTotal: number;
  diskFree: number;
  /** Bytes of memory, cgroup-aware. total is 0 when no limit is set. */
  memUsed: number;
  memTotal: number;
  /** Live per-session headless browsers. */
  browsers: number;
  /** `docker system df` rows as strings, null when no daemon is reachable. */
  docker: { type: string; size: string; reclaimable: string }[] | null;
}

export interface GitFileStatus {
  path: string;
  /** One-letter code, VS Code style: M, U (untracked), A, D, R, … */
  status: string;
  /** True when the change is in the index (a partially staged file appears twice). */
  staged: boolean;
}

export interface GitStatus {
  branch: string;
  files: GitFileStatus[];
}

export interface GitBranches {
  current: string;
  /** Local branch names. */
  local: string[];
  /** Remote-tracking branches, e.g. "origin/main". */
  remote: string[];
  /** Upstream of the current branch ("origin/main"), null when it has none. */
  upstream: string | null;
}

/** Outcome of putting a repo on an up-to-date default branch for a new session. */
export interface BranchSync {
  /** The branch the session actually starts on. */
  branch: string;
  status: "synced" | "skipped" | "failed";
  /** Why it was skipped or how it failed; absent when synced. */
  detail?: string;
}

export interface CreatedSession extends Session {
  sync: BranchSync;
}

/** A pull request as the project screen lists it. */
export interface PullRequest {
  number: number;
  title: string;
  state: "OPEN" | "MERGED" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  /** "" until a review is submitted, else APPROVED / CHANGES_REQUESTED / REVIEW_REQUIRED. */
  reviewDecision: string;
  /** Every check on the head commit, rolled into one word. */
  checks: "passing" | "failing" | "pending" | "none";
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** An issue comment or a review, flattened into one stream. */
export interface PrComment {
  author: string;
  body: string;
  createdAt: string;
  /** Review verdict (APPROVED, CHANGES_REQUESTED, …); "" for a plain comment. */
  state: string;
}

export interface PullRequestDetail extends PullRequest {
  body: string;
  /** Comments and reviews merged, oldest first. */
  comments: PrComment[];
  files: { path: string; additions: number; deletions: number }[];
}

/** Unified diff of a pull request; truncated when it was cut to fit. */
export interface PrDiff {
  diff: string;
  truncated: boolean;
}

/** Outcome of a squash merge. detail carries anything that went wrong afterwards. */
export interface MergeResult {
  merged: true;
  /** The branch the repo is on now — gh switches to the base branch on success. */
  branch: string;
  detail?: string;
}

export interface WorkflowRun {
  id: number;
  title: string;
  workflow: string;
  status: "queued" | "in_progress" | "completed";
  /** "" while the run is unfinished, else success / failure / cancelled / skipped. */
  conclusion: string;
  event: string;
  branch: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface WorkflowJob {
  name: string;
  status: string;
  conclusion: string;
  steps: { name: string; status: string; conclusion: string }[];
}

export interface WorkflowRunDetail extends WorkflowRun {
  jobs: WorkflowJob[];
}

/** Failed-job logs, sanitized; truncated when older output was dropped. */
export interface RunLog {
  log: string;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchFlags {
  /** Case-sensitive match (default: insensitive). */
  case?: boolean;
  /** Whole-word match. */
  word?: boolean;
  /** Treat the query as a regex (default: literal). */
  regex?: boolean;
}

export interface ReplaceResult {
  files: number;
  replacements: number;
}

/**
 * What a schedule does when it fires.
 *
 * "session" starts a claude session in a project and submits the prompt.
 * "assistant" runs one unattended assistant turn instead: no repo, no terminal,
 * no writes — it reads the bench and answers, and reaches the phone through its
 * notify tool when the answer needs somebody.
 */
export type ScheduleKind = "session" | "assistant";

/**
 * A recurring prompt: on its cron the pod starts a claude session in the
 * project and submits the prompt, unattended (auto permission mode).
 */
export interface Schedule {
  id: string;
  /** Human label; also the title of the sessions it starts. */
  name: string;
  kind: ScheduleKind;
  /** The repo it runs in. Empty for an assistant schedule, which has none. */
  project: string;
  /** Five-field cron, read in the pod's timezone. */
  cron: string;
  /**
   * Random delay added to each fire, in minutes (0 = fire on the dot). Spreads
   * schedules that share a cron so they don't all start at once.
   */
  jitterMinutes: number;
  prompt: string;
  /**
   * Assistant schedules only: don't run at all on a day when no session ended.
   * A pass over what happened has nothing to read when nothing happened, and a
   * turn that discovers that still costs a model call.
   */
  skipWhenIdle: boolean;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /**
   * When the timer last fired, whether or not the firing started anything, and
   * null until it first does. Distinct from lastRunAt, which is when a run was
   * last *recorded*: a tick dropped for the pause switch or an idle day records
   * nothing and still fired. The gap between this and the cron is how a boot
   * tells a tick the pod was down for from one it deliberately skipped.
   */
  lastFiredAt: string | null;
  /** Session the last run started; null for an assistant run, which starts none. */
  lastSessionId: string | null;
  /** Why the last run started nothing; null when it did. */
  lastError: string | null;
  /**
   * The verdict the last run wrote for itself ("ok: …"); null when it wrote
   * none. For an assistant schedule this is what the turn replied.
   */
  lastReport: string | null;
  /** Next fire time, computed on read; null when disabled. */
  nextRunAt: string | null;
}

/**
 * One firing of a schedule, as the inbox lists it. `outcome` is the whole run
 * rolled into one word: what the run said about itself when it said anything,
 * otherwise where it got to.
 */
export interface ScheduleRun {
  scheduleId: string;
  /** The schedule's name at the time of reading. */
  schedule: string;
  kind: ScheduleKind;
  /** Empty for an assistant run, which belongs to no repo. */
  project: string;
  at: string;
  /** Null for an assistant run, which starts no session. */
  sessionId: string | null;
  /** Why it started nothing; null when it started a session. */
  error: string | null;
  /**
   * The verdict the run wrote for itself; null when it wrote none. For an
   * assistant run this is the reply itself.
   */
  report: string | null;
  outcome: "ok" | "attention" | "failed" | "blocked" | "running" | "done";
}

export interface SettingVar {
  key: string;
  /** Where the variable is defined; values are write-only and never returned. */
  source: "env" | "settings" | "unset";
}

export interface Settings {
  /** Server config from the deployment (read-only, non-secret). */
  server: Record<string, string>;
  vars: SettingVar[];
  /** Kill switch: no schedule fires on its cron while this is on. */
  schedulesPaused: boolean;
}

/** What a browser needs to subscribe to session pushes, and who is subscribed. */
export interface PushStatus {
  /** VAPID public key; the private half never leaves the pod. */
  publicKey: string;
  devices: number;
}

/**
 * Outcome of the settings page's "send test". The push service's own rejection
 * comes back verbatim: it is the only way to tell "delivered" from "refused"
 * (a bad VAPID subject fails every push with the same opaque 403), and the app
 * has no public surface to leak it to.
 */
export interface PushTestResult {
  devices: number;
  sent: number;
  failed: number;
  error?: string;
  /** Set when the same message went out recently and this one was dropped. */
  suppressed?: boolean;
}

/** An installed SSH key. Private halves are write-only and never leave the pod. */
export interface SshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
}

export type WsClientMsg =
  | { t: "in"; data: string }
  | { t: "resize"; cols: number; rows: number }
  /** Scroll the pane's history: positive lines go back, negative go forward. */
  | { t: "scroll"; lines: number };

/** Browser pane websocket, client -> server. Mouse/key fields mirror CDP Input.dispatch*. */
export type BrowserClientMsg =
  | { t: "nav"; url: string }
  | { t: "back" }
  | { t: "forward" }
  | { t: "reload" }
  | {
      t: "mouse";
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel";
      x: number;
      y: number;
      button?: "left" | "middle" | "right" | "none";
      clickCount?: number;
      deltaX?: number;
      deltaY?: number;
      modifiers?: number;
    }
  | {
      t: "key";
      type: "keyDown" | "keyUp";
      key: string;
      code: string;
      keyCode: number;
      text?: string;
      modifiers?: number;
    }
  | { t: "resize"; width: number; height: number };

/** Browser pane websocket, server -> client. */
export type BrowserServerMsg =
  | { t: "init"; url: string; cdpUrl: string }
  | { t: "frame"; data: string; w: number; h: number }
  | { t: "url"; url: string }
  | { t: "error"; message: string };

/**
 * One tool call the assistant made inside a turn. Kept as a summary rather than
 * the full input: the chat draws these as chips, and a tool's arguments can be
 * a whole file.
 */
export interface AssistantToolCall {
  name: string;
  /** Short human-readable argument, e.g. the path read or the command run. */
  detail: string;
}

/** One turn in the assistant's thread. */
export interface AssistantEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Tool calls the assistant made before saying this. Empty for user turns. */
  tools: AssistantToolCall[];
  at: string;
  /** Set when the turn ended badly; the text then carries what went wrong. */
  failed?: boolean;
  /** Upload names attached to a user turn, served from /api/assistant/uploads. */
  images?: string[];
}

export interface AssistantThread {
  /**
   * The claude conversation id, which verksted mints rather than parses: it is
   * passed in with --session-id, so `claude --resume <id>` in a terminal lands
   * on this same thread.
   */
  conversationId: string;
  /** "thinking" while a turn is in flight; nothing can be sent until it is not. */
  status: "idle" | "thinking";
  entries: AssistantEntry[];
  /**
   * The reply being written right now, if one is. Never stored — it becomes an
   * entry the moment the model finishes the sentence — so it only ever arrives
   * over the socket, never from a plain GET.
   */
  live?: string;
}

/** One turn from an older conversation, found by searching them. */
export interface AssistantSearchHit {
  conversationId: string;
  at: string;
  role: "user" | "assistant";
  /** The matching turn, trimmed to the part around the match. */
  text: string;
}

export type MemoryType = "preference" | "project" | "reference";
/** "global", or the name of the project the fact belongs to. */
export type MemoryScope = string;

/** One thing verksted has learned about how you work. */
export interface Memory {
  slug: string;
  text: string;
  type: MemoryType;
  scope: MemoryScope;
  /** Where it came from, which is the answer to "why does it think that?". */
  source: string | null;
  createdAt: string | null;
}

export interface MemoryList {
  memories: Memory[];
  /** Bytes carried into every session, against the budget. */
  used: number;
  budget: number;
  /** Memories the budget pushed out of the injected block. */
  dropped: number;
}

/** The assistant's identity and settings, editable on the settings page. */
export interface AssistantConfig {
  /** What it calls itself. Empty means it has no name of its own. */
  name: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** Free text appended to its instructions: house style, standing orders. */
  instructions: string;
}
