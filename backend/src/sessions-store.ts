import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, Session } from "../../shared/api.js";
import { closeBrowser, nextCdpPort } from "./browser.js";
import { ensureHooksSettings, ensureMcpConfig } from "./claude-hooks.js";
import { env } from "./env.js";
import { agentEnv } from "./settings-store.js";
import * as tmux from "./tmux.js";

export const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: "claude",
  antigravity: "agy",
  codex: "codex",
};

// Agents with a verified "pick up the previous conversation" flag. Conversation
// state lives in $HOME on the PVC, so this survives pod restarts.
export const RESUME_COMMANDS: Partial<Record<AgentName, string>> = {
  claude: "claude --continue",
};

export const SESSION_ID_RE = /^vk-[A-Za-z0-9._-]+-\d+$/;

interface Meta {
  id: string;
  project: string;
  agent: AgentName;
  title: string;
  createdAt: string;
  endedAt: string | null;
  /** CDP port reserved for the session's headless browser (older metas lack it). */
  cdpPort?: number;
}

function metaPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.json`);
}

// Written by the Claude Code hooks (see claude-hooks.ts): "waiting" while the
// agent needs the user, "running" otherwise. Absent = running.
function statePath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.state`);
}

async function readState(id: string): Promise<string | null> {
  try {
    return (await fs.readFile(statePath(id), "utf8")).trim();
  } catch {
    return null;
  }
}

async function readAll(): Promise<Meta[]> {
  const files = await fs.readdir(env.SESSIONS_DIR);
  const metas: Meta[] = [];
  // Only <session-id>.json files are metadata; the dir also holds .state
  // files and claude-hooks.json.
  for (const f of files.filter((f) => f.endsWith(".json") && SESSION_ID_RE.test(f.slice(0, -5)))) {
    try {
      metas.push(JSON.parse(await fs.readFile(path.join(env.SESSIONS_DIR, f), "utf8")));
    } catch {
      // Skip unreadable/corrupt metadata rather than failing the whole list.
    }
  }
  return metas;
}

async function writeMeta(meta: Meta): Promise<void> {
  await fs.writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2));
}

function toSession(meta: Meta, live: boolean, state: string | null): Session {
  const { cdpPort: _cdpPort, ...wire } = meta;
  return { ...wire, status: !live ? "done" : state === "waiting" ? "waiting" : "running" };
}

/** The session's reserved browser CDP port, assigned lazily for pre-existing metas. */
export async function cdpPortFor(id: string): Promise<number | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const meta: Meta = JSON.parse(await fs.readFile(metaPath(id), "utf8"));
    if (!meta.cdpPort) {
      meta.cdpPort = nextCdpPort(new Set((await readAll()).map((m) => m.cdpPort!).filter(Boolean)));
      await writeMeta(meta);
    }
    return meta.cdpPort;
  } catch {
    return null;
  }
}

export async function listSessions(project?: string): Promise<Session[]> {
  const live = new Set(await tmux.listSessions());
  const metas = (await readAll()).filter((m) => !project || m.project === project);
  const out: Session[] = [];
  for (const m of metas) {
    // Sweep: a session whose tmux died without going through DELETE gets its
    // end stamped the first time anyone lists it.
    if (!m.endedAt && !live.has(m.id)) {
      m.endedAt = new Date().toISOString();
      await writeMeta(m);
      await closeBrowser(m.id);
    }
    // A shell companion must not outlive its agent session.
    if (!live.has(m.id) && live.has(`${m.id}-shell`)) {
      await tmux.killSession(`${m.id}-shell`);
    }
    out.push(toSession(m, live.has(m.id), live.has(m.id) ? await readState(m.id) : null));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSession(id: string): Promise<Session | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const meta: Meta = JSON.parse(await fs.readFile(metaPath(id), "utf8"));
    const live = new Set(await tmux.listSessions());
    return toSession(meta, live.has(id), live.has(id) ? await readState(id) : null);
  } catch {
    return null;
  }
}

export async function createSession(
  project: string,
  projectDir: string,
  agent: AgentName,
  title?: string,
  resume = false,
): Promise<Session> {
  const metas = await readAll();
  const seq =
    metas
      .filter((m) => m.project === project)
      .reduce((max, m) => Math.max(max, Number(m.id.split("-").at(-1))), 0) + 1;
  const meta: Meta = {
    id: `vk-${project}-${seq}`,
    project,
    agent,
    title: title?.trim() || `${agent}-${seq}`,
    createdAt: new Date().toISOString(),
    endedAt: null,
    cdpPort: nextCdpPort(new Set(metas.map((m) => m.cdpPort!).filter(Boolean))),
  };
  let command = (resume && RESUME_COMMANDS[agent]) || AGENT_COMMANDS[agent];
  const extraEnv = await agentEnv();
  // The session's headless browser (launched on demand, see browser.ts): the
  // agent connects playwright to VK_BROWSER_CDP to test in a browser the user
  // can watch in the UI. POST /api/sessions/$VK_SESSION_ID/browser/start boots
  // it if nothing is connected yet.
  extraEnv.VK_SESSION_ID = meta.id;
  extraEnv.VK_BROWSER_CDP = `http://127.0.0.1:${meta.cdpPort}`;
  if (agent === "claude") {
    // Status hooks: claude writes waiting/running into the session state file.
    // MCP config: the playwright MCP drives the session browser.
    command += ` --settings "${await ensureHooksSettings()}" --mcp-config "${await ensureMcpConfig()}"`;
    extraEnv.VK_STATE_FILE = statePath(meta.id);
  }
  // A purged session's id can be reused; drop any stale state from it.
  await fs.rm(statePath(meta.id), { force: true });
  await tmux.newSession(meta.id, projectDir, command, extraEnv);
  await writeMeta(meta);
  return toSession(meta, true, null);
}

/** Kill any live tmux sessions for a project and remove all its metadata files. */
export async function deleteProjectSessions(project: string): Promise<void> {
  const live = new Set(await tmux.listSessions());
  const metas = (await readAll()).filter((m) => m.project === project);
  for (const m of metas) {
    if (live.has(m.id)) await tmux.killSession(m.id);
    if (live.has(`${m.id}-shell`)) await tmux.killSession(`${m.id}-shell`);
    await closeBrowser(m.id);
    await fs.rm(metaPath(m.id), { force: true });
    await fs.rm(statePath(m.id), { force: true });
  }
}

export async function endSession(id: string): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  if (session.status !== "done") await tmux.killSession(id);
  const live = new Set(await tmux.listSessions());
  if (live.has(`${id}-shell`)) await tmux.killSession(`${id}-shell`);
  await closeBrowser(id);
  const meta: Meta = { ...session, endedAt: session.endedAt ?? new Date().toISOString() };
  await writeMeta({
    id: meta.id,
    project: meta.project,
    agent: meta.agent,
    title: meta.title,
    createdAt: meta.createdAt,
    endedAt: meta.endedAt,
  });
  return { ...meta, status: "done" };
}

/** End the session (tmux + shell companion) and remove it from history. */
export async function deleteSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;
  if (session.status !== "done") await tmux.killSession(id);
  const live = new Set(await tmux.listSessions());
  if (live.has(`${id}-shell`)) await tmux.killSession(`${id}-shell`);
  await closeBrowser(id);
  await fs.rm(metaPath(id), { force: true });
  await fs.rm(statePath(id), { force: true });
  return true;
}
