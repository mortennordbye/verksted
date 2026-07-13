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

/** Vars set via the settings page, persisted on the data volume. */
export async function readVars(): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await fs.readFile(env.SETTINGS_FILE, "utf8"));
    return parsed.vars ?? {};
  } catch {
    return {};
  }
}

export async function writeVars(vars: Record<string, string>): Promise<void> {
  await fs.writeFile(env.SETTINGS_FILE, JSON.stringify({ vars }, null, 2));
}

/** Settings vars safe to inject into a new tmux session's environment. */
export async function agentEnv(): Promise<Record<string, string>> {
  const vars = await readVars();
  for (const key of Object.keys(vars)) {
    if (BLOCKED_KEYS.has(key)) delete vars[key];
  }
  return vars;
}
