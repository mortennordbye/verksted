import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { env } from "./env.js";

/** Agent vars the settings page always lists (mirrors .env.example). */
export const KNOWN_AGENT_KEYS = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTIGRAVITY_API_KEY",
  "OPENAI_API_KEY",
  "GH_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

// ANTHROPIC_API_KEY silently overrides Claude Max subscription auth and bills
// per token — never storable, never injected.
export const BLOCKED_KEYS = new Set(["ANTHROPIC_API_KEY"]);

export const VAR_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface Stored {
  vars?: Record<string, string>;
  /** Kill switch for the scheduler; see scheduler.ts. */
  schedulesPaused?: boolean;
}

async function read(): Promise<Stored> {
  try {
    return JSON.parse(await fs.readFile(env.SETTINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

// Read-modify-write, so writing one field never drops the others. 0600 because
// this file holds plaintext tokens — mode on writeFile only applies when the
// file is created, so chmod covers a file already written at the old 0644.
//
// Write-temp-then-rename: a truncated settings.json is every credential the
// user has entered, and read() swallows the parse error and returns {}, so a
// crash mid-write would silently unset all of them.
async function write(patch: Stored): Promise<void> {
  const data = JSON.stringify({ ...(await read()), ...patch }, null, 2);
  const tmp = `${env.SETTINGS_FILE}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    await fs.rename(tmp, env.SETTINGS_FILE);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Vars set via the settings page, persisted on the data volume. */
export async function readVars(): Promise<Record<string, string>> {
  return (await read()).vars ?? {};
}

export async function writeVars(vars: Record<string, string>): Promise<void> {
  await write({ vars });
}

export async function schedulesPaused(): Promise<boolean> {
  return (await read()).schedulesPaused === true;
}

export async function setSchedulesPaused(paused: boolean): Promise<void> {
  await write({ schedulesPaused: paused });
}

/** Settings vars safe to inject into a new tmux session's environment. */
export async function agentEnv(): Promise<Record<string, string>> {
  const vars = await readVars();
  for (const key of Object.keys(vars)) {
    if (BLOCKED_KEYS.has(key)) delete vars[key];
  }
  return vars;
}

/**
 * The only settings vars git and gh need when the *backend itself* runs them.
 *
 * agentEnv() must not be used for that: VAR_KEY_RE accepts any uppercase key, so
 * PATH, LD_PRELOAD, GIT_SSH_COMMAND or GIT_EXTERNAL_DIFF set from the settings
 * page would change which binary the backend executes. Inside a tmux session
 * that is only the agent's own shell environment, which it controls anyway;
 * here it is remote code execution in the server process. Allowlist, not
 * denylist — a new var added to the settings page must not silently become a
 * backend exec input.
 */
const EXEC_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
];

export async function execEnv(): Promise<Record<string, string>> {
  const vars = await readVars();
  const out: Record<string, string> = {};
  for (const key of EXEC_KEYS) {
    const value = vars[key];
    if (value !== undefined && !BLOCKED_KEYS.has(key)) out[key] = value;
  }
  return out;
}
