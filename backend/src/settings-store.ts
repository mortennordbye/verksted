import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import type { AssistantConfig } from "../../shared/api.js";
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
  // Where headroom is, and how to log in. Agent vars rather than deployment
  // config because the backend never reads them: they reach headroom's MCP
  // server the way every other credential here reaches a CLI, by being in the
  // environment its process was spawned with.
  "HEADROOM_URL",
  "HEADROOM_PASSWORD",
  // Mail and calendar, read by the backend itself (see mail.ts, calendar.ts).
  // Typed on the phone like the rest, and unlike the rest never injected into
  // a session: a coding agent has no business holding a mail password.
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "CALDAV_URL",
  "CALDAV_USER",
  "CALDAV_PASSWORD",
];

/**
 * Vars the backend reads for its own sources, and agentEnv leaves out.
 *
 * Allowlisted the way EXEC_KEYS is, and for the same reason: a settings var
 * must never become an input to the server process by accident. These are
 * the only ones the pollers read, and no session is ever handed them.
 */
export const SOURCE_KEYS = [
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_USER",
  "IMAP_PASSWORD",
  "CALDAV_URL",
  "CALDAV_USER",
  "CALDAV_PASSWORD",
];
const SOURCE_ONLY = new Set(SOURCE_KEYS);

// ANTHROPIC_API_KEY silently overrides Claude Max subscription auth and bills
// per token — never storable, never injected.
export const BLOCKED_KEYS = new Set(["ANTHROPIC_API_KEY"]);

export const VAR_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

interface Stored {
  vars?: Record<string, string>;
  /** The assistant's identity; see assistant-persona.ts. */
  assistant?: Partial<AssistantConfig>;
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

/**
 * One agent credential as a session would see it: the settings page's value,
 * else the process environment's (the cluster's secret reaches the pod that
 * way, and sessions inherit it from the backend through tmux). For the few
 * things the backend itself does with a credential — reading the plan's
 * windows — rather than the sessions, which get all of it through agentEnv.
 */
export async function credential(
  key: (typeof KNOWN_AGENT_KEYS)[number],
): Promise<string | undefined> {
  return (await readVars())[key] || process.env[key] || undefined;
}

export async function writeVars(vars: Record<string, string>): Promise<void> {
  await write({ vars });
}

/**
 * The messenger: what this thing does every day is tell you what needs you.
 * Named to sit beside the cluster it runs on, which is Genesis.
 */
export const DEFAULT_NAME = "Gabriel";

/**
 * The assistant's identity, with the deployment env as the fallback for the two
 * that cost money. Stored beside the agent vars because it is the same kind of
 * thing: something the person tunes from their phone, persisted on the volume,
 * outliving the container.
 */
export async function readAssistantConfig(): Promise<AssistantConfig> {
  const stored = (await read()).assistant ?? {};
  return {
    // Nullish rather than falsy, so a name deliberately cleared stays cleared
    // instead of springing back on the next read.
    name: stored.name ?? DEFAULT_NAME,
    model: stored.model || env.ASSISTANT_MODEL,
    effort: stored.effort ?? (env.ASSISTANT_EFFORT as AssistantConfig["effort"]),
    instructions: stored.instructions ?? "",
  };
}

export async function writeAssistantConfig(patch: Partial<AssistantConfig>): Promise<void> {
  const current = (await read()).assistant ?? {};
  await write({ assistant: { ...current, ...patch } });
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
    if (BLOCKED_KEYS.has(key) || SOURCE_ONLY.has(key)) delete vars[key];
  }
  return vars;
}

/** The mail and calendar credentials, for the backend's own readers only. */
export async function sourceEnv(): Promise<Record<string, string>> {
  const vars = await readVars();
  const out: Record<string, string> = {};
  for (const key of SOURCE_KEYS) {
    const value = vars[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
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
