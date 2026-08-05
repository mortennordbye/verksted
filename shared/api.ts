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
}

export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  modified?: boolean;
  children?: TreeNode[];
}

export interface FileContent {
  path: string;
  content: string;
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
 * A recurring prompt: on its cron the pod starts a claude session in the
 * project and submits the prompt, unattended (auto permission mode).
 */
export interface Schedule {
  id: string;
  /** Human label; also the title of the sessions it starts. */
  name: string;
  project: string;
  /** Five-field cron, read in the pod's timezone. */
  cron: string;
  /**
   * Random delay added to each fire, in minutes (0 = fire on the dot). Spreads
   * schedules that share a cron so they don't all start at once.
   */
  jitterMinutes: number;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  lastRunAt: string | null;
  /** Session the last run started; null when it never ran or could not start. */
  lastSessionId: string | null;
  /** Why the last run started nothing; null when it did. */
  lastError: string | null;
  /** The verdict the last run wrote for itself ("ok: …"); null when it wrote none. */
  lastReport: string | null;
  /** Next fire time, computed on read; null when disabled. */
  nextRunAt: string | null;
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
