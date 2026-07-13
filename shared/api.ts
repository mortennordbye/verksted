// Wire types shared between backend and frontend. Types only — no runtime code.

export type AgentName = "claude" | "antigravity" | "codex";

export interface Project {
  name: string;
  branch: string;
  dirty: boolean;
  running: number;
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
  status: "running" | "done";
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

export interface GitFileStatus {
  path: string;
  /** One-letter code, VS Code style: M, U (untracked), A, D, R, … */
  status: string;
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

export type WsClientMsg =
  | { t: "in"; data: string }
  | { t: "resize"; cols: number; rows: number };
