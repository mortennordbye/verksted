import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, Session } from "../../shared/api.js";
import { env } from "./env.js";
import * as tmux from "./tmux.js";

export const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: "claude",
  antigravity: "agy",
  codex: "codex",
};

export const SESSION_ID_RE = /^vk-[A-Za-z0-9._-]+-\d+$/;

interface Meta {
  id: string;
  project: string;
  agent: AgentName;
  title: string;
  createdAt: string;
  endedAt: string | null;
}

function metaPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.json`);
}

async function readAll(): Promise<Meta[]> {
  const files = await fs.readdir(env.SESSIONS_DIR);
  const metas: Meta[] = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
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

function toSession(meta: Meta, live: boolean): Session {
  return { ...meta, status: live ? "running" : "done" };
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
    }
    out.push(toSession(m, live.has(m.id)));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSession(id: string): Promise<Session | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const meta: Meta = JSON.parse(await fs.readFile(metaPath(id), "utf8"));
    const live = new Set(await tmux.listSessions());
    return toSession(meta, live.has(id));
  } catch {
    return null;
  }
}

export async function createSession(
  project: string,
  projectDir: string,
  agent: AgentName,
  title?: string,
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
  };
  await tmux.newSession(meta.id, projectDir, AGENT_COMMANDS[agent]);
  await writeMeta(meta);
  return toSession(meta, true);
}

export async function endSession(id: string): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  if (session.status === "running") await tmux.killSession(id);
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
