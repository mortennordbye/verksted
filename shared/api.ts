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

/** An installed SSH key. Private halves are write-only and never leave the pod. */
export interface SshKey {
  name: string;
  publicKey: string;
  fingerprint: string;
}

export type WsClientMsg =
  | { t: "in"; data: string }
  | { t: "resize"; cols: number; rows: number };

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
