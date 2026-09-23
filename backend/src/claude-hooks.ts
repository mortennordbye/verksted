import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";

// Session-status hooks for Claude Code, passed via `claude --settings <file>`
// (merged with the user's own settings). The state hooks write the session's
// state file ($VK_STATE_FILE, set per session in createSession): Notification and
// Stop mean the agent needs the user; UserPromptSubmit and PreToolUse flip
// back to running. `|| true` keeps every hook exit 0 — a nonzero exit (2)
// would block claude.
function write(state: "waiting" | "running") {
  return {
    type: "command",
    command: `[ -n "$VK_STATE_FILE" ] && printf ${state} > "$VK_STATE_FILE" || true`,
  };
}

// Record the conversation claude is currently in, from the session_id every
// hook payload carries on stdin. It is what lets a restarted pod put the
// session back on the same conversation (sessions-store restoreSessions)
// instead of guessing with --continue. Re-recorded on every prompt, not just at
// start: a resumed conversation can come back under a different id. Written
// only when jq produced one, so a parse failure leaves the last good id alone.
const CONVERSATION = {
  type: "command",
  command:
    `id=$(jq -r '.session_id // empty' 2>/dev/null); ` +
    `[ -n "$id" ] && [ -n "$VK_CONV_FILE" ] && printf %s "$id" > "$VK_CONV_FILE" || true`,
};

const SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [CONVERSATION] }],
    Notification: [{ hooks: [write("waiting")] }],
    Stop: [{ hooks: [write("waiting")] }],
    UserPromptSubmit: [{ hooks: [write("running"), CONVERSATION] }],
    PreToolUse: [{ hooks: [write("running")] }],
  },
  // The session browser is claude's to drive; don't prompt per tool call.
  permissions: { allow: ["mcp__browser"] },
};

// An unattended run that stops without signing off is recorded as a failure
// rather than read as a night when all was well: silence is the one report
// the inbox must never take at face value. Only when the file is empty, so a
// run that did sign off keeps its own verdict.
const DEFAULT_REPORT = {
  type: "command",
  command:
    `[ -n "$VK_REPORT_FILE" ] && [ ! -s "$VK_REPORT_FILE" ] && ` +
    `printf 'failed: no sign-off' > "$VK_REPORT_FILE" || true`,
};

// The guard is a script rather than a pattern list because the calls worth
// stopping — a push that targets main under another spelling, an rm whose
// path resolves outside the worktree — are not expressible as a permission
// rule. Exit 2 from it denies the call; see runtime/vk-guard.
const GUARD = { type: "command", command: "vk-guard" };

/**
 * The settings for a run nobody is waiting for. Permission mode dontAsk runs
 * what these allow rules and the guard approve and denies the rest outright,
 * so the session never turns amber and never pushes a phone at 03:00. Stop
 * writes a report rather than "waiting" for the same reason. The deny list
 * holds in every mode and is the belt under the guard's braces.
 */
const UNATTENDED = {
  hooks: {
    SessionStart: [{ hooks: [CONVERSATION] }],
    UserPromptSubmit: [{ hooks: [write("running"), CONVERSATION] }],
    PreToolUse: [
      { hooks: [write("running")] },
      { matcher: "Bash|Edit|Write|MultiEdit|NotebookEdit", hooks: [GUARD] },
    ],
    Stop: [{ hooks: [DEFAULT_REPORT] }],
    SessionEnd: [{ hooks: [DEFAULT_REPORT] }],
  },
  permissions: {
    allow: [
      "mcp__browser",
      "Bash",
      "Edit",
      "Write",
      "MultiEdit",
      "Read",
      "Glob",
      "Grep",
      "WebFetch(domain:github.com)",
    ],
    deny: [
      "Bash(git push --force*)",
      "Bash(git push -f*)",
      "Bash(git reset --hard*)",
      "Bash(rm -rf /*)",
      "Bash(gh repo delete*)",
      "Bash(kubectl delete*)",
      "Bash(docker system prune*)",
      "Bash(vk restore*)",
      "Read(~/.ssh/**)",
    ],
  },
};

/** Write the hooks settings file (on the data volume) and return its path. */
export async function ensureHooksSettings(unattended = false): Promise<string> {
  const file = path.join(
    env.SESSIONS_DIR,
    unattended ? "claude-hooks-unattended.json" : "claude-hooks.json",
  );
  // Rewritten on every launch while running CLIs may be re-reading it.
  await writeJsonAtomic(file, unattended ? UNATTENDED : SETTINGS);
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
  await writeJsonAtomic(file, config);
  return file;
}

/**
 * The other two agents, set up the way their CLIs read it.
 *
 * Read from each CLI's own binary and `--help` on the pod (codex-cli 0.155.1,
 * agy 1.2.8), not run against a signed-in one: neither is signed in there yet.
 * codex has a hooks engine shaped like claude's — the same event names, the
 * same `matcher`/`hooks`/`command` entries — read from ~/.codex/hooks.json, so
 * its sessions get the same waiting/running state and conversation id. agy's
 * hook format could not be read out of the binary, so it gets the browser and
 * the instructions file and no status yet (BACKLOG).
 */
const home = () => process.env.HOME ?? "/data/home";

/** The session browser's MCP server, as a script both codex and agy can name. */
export async function ensureBrowserMcpScript(): Promise<string> {
  const file = path.join(env.SESSIONS_DIR, "browser-mcp.sh");
  await fs.writeFile(
    file,
    [
      "#!/bin/sh",
      "# The session browser for an agent's MCP client: boot it through the",
      "# backend, then hand playwright-mcp the CDP endpoint it booted.",
      `curl -sf -X POST http://127.0.0.1:${env.PORT}/api/sessions/"$VK_SESSION_ID"/browser/start >/dev/null 2>&1`,
      'exec playwright-mcp --cdp-endpoint "$VK_BROWSER_CDP"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return file;
}

/** codex's hooks: the claude hooks' state and conversation writes, in codex's file. */
export async function ensureCodexHooks(): Promise<void> {
  const file = path.join(home(), ".codex", "hooks.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    hooks: {
      SessionStart: [{ hooks: [CONVERSATION] }],
      Stop: [{ hooks: [write("waiting")] }],
      PermissionRequest: [{ hooks: [write("waiting")] }],
      UserPromptSubmit: [{ hooks: [write("running"), CONVERSATION] }],
      PreToolUse: [{ hooks: [write("running")] }],
    },
  });
}

/** codex's MCP servers for a session, as `-c` overrides on its command line. */
export function codexMcpArgs(script: string): string {
  return ` -c 'mcp_servers.browser.command="${script}"'`;
}

/** agy's MCP servers: its own config file, with the browser merged in. */
export async function ensureAgyMcp(script: string): Promise<void> {
  const file = path.join(home(), ".gemini", "config", "mcp_config.json");
  let config: { mcpServers?: Record<string, unknown> } = {};
  try {
    config = JSON.parse(await fs.readFile(file, "utf8")) as typeof config;
  } catch {
    // None yet, or one this cannot read: the browser alone.
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeJsonAtomic(file, {
    ...config,
    mcpServers: { ...(config.mcpServers ?? {}), browser: { command: script, args: [] } },
  });
}
