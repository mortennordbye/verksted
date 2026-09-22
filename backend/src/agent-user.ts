import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * The unix user everything an agent can steer runs as (root cause 1).
 *
 * A session's agent has a shell, and until this it had the backend's uid: it
 * could read settings.json with every token in it, the assistant's threads, the
 * feed, and call any route the backend serves. Under its own user it keeps
 * what it works with (the repos, its own HOME) and loses the rest. The backend
 * stays root, which is what lets it start processes as that user and reach its
 * tmux server.
 *
 * No imports of env.ts, on purpose: exec.ts depends on this, a great many
 * tests import exec.ts before they set their directories, and env.ts reads
 * them all once, on first import. The bootstrap hands the value over instead.
 */
export interface AgentUser {
  name: string;
  uid: number;
  gid: number;
  home: string;
}

let agent: AgentUser | null = null;
let socket = "";
/** Where the backend may hand a path over: the agent's HOME and these. */
let roots: string[] = [];

/** Read a user out of /etc/passwd; throws when there is none, so a typo fails the boot. */
export function lookupUser(name: string, passwd = readFileSync("/etc/passwd", "utf8")): AgentUser {
  for (const line of passwd.split("\n")) {
    const [user, , uid, gid, , home] = line.split(":");
    if (user === name && uid && gid && home) {
      return { name, uid: Number(uid), gid: Number(gid), home };
    }
  }
  throw new Error(`VK_AGENT_USER names "${name}", and there is no such user`);
}

/**
 * Called once by the bootstrap; `name` empty keeps everything as the backend's
 * own user. `handOver` is every directory besides the agent's HOME that the
 * backend writes into for it.
 */
export function configureAgent(
  name: string,
  tmuxSocket: string,
  handOver: string[],
): AgentUser | null {
  setAgent(name ? lookupUser(name) : null, tmuxSocket, handOver);
  return agent;
}

/** For tests: set the user directly, or clear it. */
export function setAgent(user: AgentUser | null, tmuxSocket = "", handOver: string[] = []): void {
  agent = user;
  socket = user ? tmuxSocket : "";
  roots = user ? [user.home, ...handOver].map((r) => path.resolve(r)) : [];
}

/**
 * A chown by root is a way to hand anything on the volume to the agent, so it
 * is refused outside the directories it is for, whatever the caller built.
 */
function handable(p: string): string {
  const abs = path.resolve(p);
  if (!roots.some((r) => abs === r || abs.startsWith(r + path.sep))) {
    throw new Error(`not handing ${abs} to the agent user: outside its directories`);
  }
  return abs;
}

export function agentUser(): AgentUser | null {
  return agent;
}

/**
 * tmux's `-S` for the agent user's server, or nothing. Every tmux the backend
 * runs names it: root's default socket is not the one the agent's server made.
 */
export function tmuxSocketArgs(): string[] {
  return socket ? ["-S", socket] : [];
}

/**
 * Spawn options that make a child the agent user: its ids, and a HOME that is
 * its own, since git, gh and the CLIs all read their config from there. The
 * rest of the environment is the caller's.
 */
export function asAgent(base: NodeJS.ProcessEnv = process.env): {
  uid?: number;
  gid?: number;
  env?: NodeJS.ProcessEnv;
} {
  if (!agent) return {};
  return {
    uid: agent.uid,
    gid: agent.gid,
    env: { ...base, HOME: agent.home, USER: agent.name, LOGNAME: agent.name },
  };
}

/**
 * Hand a path the backend just wrote inside the repos to the agent user, so a
 * session can go on editing it. lchown: a link is never followed to whatever
 * it points at. A no-op with no agent user.
 */
export async function giveToAgent(...paths: string[]): Promise<void> {
  if (!agent) return;
  for (const p of paths) await fs.lchown(handable(p), agent.uid, agent.gid);
}

/**
 * The same for a directory `mkdir -p` may have made several levels of: every
 * level from `top` (which already existed and is left alone) down to `dir`.
 */
export async function giveDirToAgent(top: string, dir: string): Promise<void> {
  if (!agent) return;
  const rel = path.relative(top, dir);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return;
  let at = top;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    await fs.lchown(handable(at), agent.uid, agent.gid);
  }
}
