import fs from "node:fs/promises";
import path from "node:path";
import { agentUser } from "./agent-user.js";
import { assistantHome } from "./assistant-policy.js";
import { claudeProjectDir } from "./claude-home.js";
import { env } from "./env.js";
import { exec } from "./exec.js";
import type { Logger } from "./logger.js";

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
  if (!agent) return takeBack(log);
  const owner = `${agent.uid}:${agent.gid}`;

  // Where the agent user's tmux server makes its socket.
  const socketDir = path.dirname(env.VK_TMUX_SOCKET);
  await fs.mkdir(socketDir, { recursive: true, mode: 0o700 });
  await fs.chown(socketDir, agent.uid, agent.gid);
  await fs.chmod(socketDir, 0o700);

  const home = assistantHome();
  await fs.mkdir(home, { recursive: true, mode: 0o700 });

  const first = !(await exists(stamp()));
  if (first) {
    await moveAssistantTranscripts(agent.home, home, log);
    const started = Date.now();
    await exec("chown", ["-R", "-h", owner, env.REPOS_DIR, agent.home], { timeout: 0 });
    await fs.writeFile(stamp(), `${new Date().toISOString()}\n`);
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

/** Written once the repos and HOME are the agent user's; what `takeBack` looks for. */
const stamp = () => path.join(env.SESSIONS_DIR, ".agent-owned");

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

/**
 * The agent user turned off again, on a volume it was once on for: the repos,
 * HOME and the assistant's transcripts come back to the backend, which runs
 * everything again. Without this git refuses every repo ("dubious ownership":
 * it will not work in one another user owns), so the projects, the GitHub
 * feed and every session broke the moment the variable came out. Once, like
 * the handover: the stamp goes with it, and turning it on again hands over in
 * full.
 */
async function takeBack(log: Logger): Promise<void> {
  if (!(await exists(stamp()))) return;
  const home = process.env.HOME ?? "/data/home";
  await moveAssistantTranscripts(path.join(env.ASSISTANT_DIR, "home"), home, log);
  const started = Date.now();
  const self = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
  await exec("chown", ["-R", "-h", self, env.REPOS_DIR, home], { timeout: 0 });
  await fs.rm(stamp());
  log.info(`took the repos and ${home} back from the agent user in ${Date.now() - started} ms`);
}

/**
 * The assistant runs with cwd REPOS_DIR, so its transcripts are one project
 * directory under claude's HOME; sessions run inside a repo and are others.
 */
async function moveAssistantTranscripts(from: string, to: string, log: Logger): Promise<void> {
  const src = claudeProjectDir(env.REPOS_DIR, from);
  const dest = claudeProjectDir(env.REPOS_DIR, to);
  let names: string[];
  try {
    names = await fs.readdir(src);
  } catch {
    return;
  }
  await fs.mkdir(dest, { recursive: true, mode: 0o700 });
  // One by one rather than the directory at once: the other side may already
  // hold transcripts of its own, written while the pod ran the other way.
  let moved = 0;
  for (const name of names) {
    if (await exists(path.join(dest, name))) continue;
    try {
      await fs.rename(path.join(src, name), path.join(dest, name));
      moved++;
    } catch (err) {
      // Left where they were, the old threads start fresh conversations: worse,
      // and not a reason to keep the pod down.
      log.warn(err, `could not move ${name} from ${src}`);
    }
  }
  if (moved) log.info(`moved ${moved} of the assistant's transcripts to ${dest}`);
}
