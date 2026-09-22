import fs from "node:fs/promises";
import path from "node:path";
import { agentUser } from "./agent-user.js";
import { assistantHome } from "./assistant-policy.js";
import { claudeProjectDir } from "./claude-home.js";
import { env } from "./env.js";
import { exec } from "./exec.js";

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * The volume as privilege separation needs it, at boot and before any session
 * is restored (root cause 1). A no-op with no agent user.
 *
 * - The agent user owns what sessions work in: the repos and its HOME. Once,
 *   in full, on the boot that turns this on (a stamp says it happened), and
 *   the two top directories on every boot after, since chown -R over every
 *   repo on NFS is minutes.
 * - The assistant's transcripts leave that HOME for its own (assistantHome):
 *   they hold what its turns read of the person's mail and documents.
 * - What only the backend reads is closed to everyone else: its stores 0700,
 *   the settings and the push keys 0600. The sessions directory stays
 *   traversable, since a session reads its hooks there and writes its own
 *   state files, which the backend hands it.
 */
export async function prepareForAgents(log: Logger): Promise<void> {
  const agent = agentUser();
  if (!agent) return;
  const owner = `${agent.uid}:${agent.gid}`;

  // Where the agent user's tmux server makes its socket.
  const socketDir = path.dirname(env.VK_TMUX_SOCKET);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.chown(socketDir, agent.uid, agent.gid);
  await fs.chmod(socketDir, 0o700);

  const home = assistantHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });

  const stamp = path.join(env.SESSIONS_DIR, ".agent-owned");
  const first = await fs.access(stamp).then(
    () => false,
    () => true,
  );
  if (first) {
    await moveAssistantTranscripts(agent.home, home, log);
    const started = Date.now();
    await exec("chown", ["-R", "-h", owner, env.REPOS_DIR, agent.home], { timeout: 0 });
    await fs.writeFile(stamp, `${new Date().toISOString()}\n`);
    log.info(`handed the repos and ${agent.home} to ${agent.name} in ${Date.now() - started} ms`);
  } else {
    for (const dir of [env.REPOS_DIR, agent.home]) await fs.lchown(dir, agent.uid, agent.gid);
  }

  for (const dir of [
    env.SCHEDULES_DIR,
    env.ASSISTANT_DIR,
    env.MEMORY_DIR,
    env.COUNCIL_DIR,
    env.FEED_DIR,
    env.LOOPS_DIR,
    env.USAGE_DIR,
    env.DOCS_INDEX_DIR,
  ]) {
    await fs.chmod(dir, 0o700);
  }
  await fs.chmod(env.SESSIONS_DIR, 0o711);
  for (const file of [env.SETTINGS_FILE, env.PUSH_FILE]) {
    await fs.chmod(file, 0o600).catch(() => {});
  }
  // The archives hold every token in the clear until a passphrase is set. An
  // NFS share may refuse a chmod, and the backup says so itself.
  await fs.chmod(env.VK_BACKUP_DIR, 0o700).catch((err: unknown) => {
    log.warn(err, `could not close ${env.VK_BACKUP_DIR} to other users`);
  });
}

/**
 * The assistant runs with cwd REPOS_DIR, so its transcripts are one project
 * directory under claude's HOME; sessions run inside a repo and are others.
 */
async function moveAssistantTranscripts(from: string, to: string, log: Logger): Promise<void> {
  const src = claudeProjectDir(env.REPOS_DIR, from);
  const dest = claudeProjectDir(env.REPOS_DIR, to);
  try {
    await fs.access(src);
  } catch {
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
  try {
    await fs.rename(src, dest);
    log.info(`moved the assistant's transcripts to ${dest}`);
  } catch (err) {
    // Left where they were, the old threads start fresh conversations: worse,
    // and not a reason to keep the pod down.
    log.warn(err, `could not move the assistant's transcripts from ${src}`);
  }
}
