import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";

// Session-status hooks for Claude Code, passed via `claude --settings <file>`
// (merged with the user's own settings). Each hook writes the session's state
// file ($VK_STATE_FILE, set per session in createSession): Notification and
// Stop mean the agent needs the user; UserPromptSubmit and PreToolUse flip
// back to running. `|| true` keeps every hook exit 0 — a nonzero exit (2)
// would block claude.
function write(state: "waiting" | "running") {
  return {
    hooks: [
      {
        type: "command",
        command: `[ -n "$VK_STATE_FILE" ] && printf ${state} > "$VK_STATE_FILE" || true`,
      },
    ],
  };
}

const SETTINGS = {
  hooks: {
    Notification: [write("waiting")],
    Stop: [write("waiting")],
    UserPromptSubmit: [write("running")],
    PreToolUse: [write("running")],
  },
  // The session browser is claude's to drive; don't prompt per tool call.
  permissions: { allow: ["mcp__browser"] },
};

/** Write the hooks settings file (on the data volume) and return its path. */
export async function ensureHooksSettings(): Promise<string> {
  const file = path.join(env.SESSIONS_DIR, "claude-hooks.json");
  await fs.writeFile(file, JSON.stringify(SETTINGS, null, 2));
  return file;
}

/**
 * MCP config (claude --mcp-config) wiring the playwright MCP to the session's
 * browser: the wrapper boots the browser via the backend, then connects to
 * $VK_BROWSER_CDP — so claude tests in the same browser the pane streams.
 */
export async function ensureMcpConfig(): Promise<string> {
  const config = {
    mcpServers: {
      browser: {
        command: "sh",
        args: [
          "-c",
          `curl -sf -X POST http://127.0.0.1:${env.PORT}/api/sessions/"$VK_SESSION_ID"/browser/start >/dev/null 2>&1; ` +
            'exec playwright-mcp --cdp-endpoint "$VK_BROWSER_CDP"',
        ],
      },
    },
  };
  const file = path.join(env.SESSIONS_DIR, "claude-mcp.json");
  await fs.writeFile(file, JSON.stringify(config, null, 2));
  return file;
}
