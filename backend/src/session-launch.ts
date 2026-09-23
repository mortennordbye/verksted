import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, CreatedSession, MaintainerStage } from "../../shared/api.js";
import { agentUser, giveToAgent } from "./agent-user.js";
import { sweepTempFiles, writeJsonAtomic } from "./atomic-json.js";
import { nextCdpPort } from "./browser.js";
import { ensureHooksSettings, ensureMcpConfig } from "./claude-hooks.js";
import { env } from "./env.js";
import { headCommit, syncDefaultBranch } from "./git.js";
import { LimitError, MAX_LIVE_SESSIONS } from "./limits.js";
import { resolveInsideRepos } from "./paths.js";
import { agentEnv } from "./settings-store.js";
import * as tmux from "./tmux.js";
import type { Logger } from "./logger.js";
import type { Meta } from "./sessions-store.js";
import {
  AGENT_COMMANDS,
  cdpPortFor,
  RESUME_COMMANDS,
  SESSION_ID_RE,
  convPath,
  exitPath,
  liveNames,
  metaPath,
  readAll,
  readConv,
  reportPath,
  sessionDir,
  statePath,
  toSession,
  usedCdpPorts,
  writeMeta,
  writeReport,
} from "./sessions-store.js";

/**
 * Starting a session: the agent's command line, its environment, the sequence
 * number, and bringing sessions back after a restart. Out of sessions-store.ts
 * (R-34), which keeps what a session is on disk and how it is read.
 */

export interface LaunchOptions {
  /** Session title; defaults to "<agent>-<seq>". */
  title?: string;
  /** Pick up the agent's previous conversation in this project. */
  resume?: boolean;
  /** First prompt, submitted as the session starts (scheduled runs). */
  prompt?: string;
  /**
   * Claude's "auto" permission mode: a classifier approves the routine tool
   * calls and still stops for the rest. What an unattended run wants — nobody
   * is there to confirm `git status`, and the calls that do stop it show up as
   * a waiting session, which is exactly what the notifier pushes.
   */
  autoPermissions?: boolean;
  /**
   * The other kind of unattended: a maintainer stage that nobody will pick up
   * if it stops. Claude runs headless in dontAsk mode — what the allow rules
   * and the guard hook approve goes through, the rest is denied outright, and
   * the run ends when the agent exits or the scheduler's cap ends it. Never
   * combined with autoPermissions; one says "ask me", the other "you cannot".
   */
  unattended?: MaintainerStage;
  /** The issue a build run is for; travels to the guard and the prompt. */
  issue?: number;
}

/**
 * Turns a headless run may take before claude stops it. A scout that reads a
 * repo and files a few issues is well under a hundred; this is the backstop
 * for one that has lost the thread, in front of the scheduler's wall clock.
 */
const UNATTENDED_MAX_TURNS = 200;

/**
 * Standing context for a project, prepended to whatever a session is asked to
 * do. Lives in the repo at .verksted/context.md — the same hidden directory
 * phone uploads use, which is already kept out of git via .git/info/exclude.
 *
 * The point is that the hub stops being stateless. Conventions, decisions and
 * the shape of the repo are re-explained to every agent otherwise, and on a
 * phone re-typing them is the expensive part.
 *
 * Read at launch rather than cached: editing the file should affect the next
 * session, not the next restart.
 */
export const CONTEXT_PATH = ".verksted/context.md";

async function projectContext(projectDir: string): Promise<string | null> {
  try {
    const text = await fs.readFile(path.join(projectDir, CONTEXT_PATH), "utf8");
    const trimmed = text.trim();
    // Bounded: it becomes part of an argv-delivered env var, and an accidental
    // paste of a whole file should not push the real prompt out of the window.
    return trimmed ? trimmed.slice(0, 8_000) : null;
  } catch {
    return null;
  }
}

/**
 * Start a session's agent in a fresh tmux session named after it. `base` is the
 * agent command with any resume flag already on it; everything after it — the
 * status hooks, the session browser, the per-session env — is identical whether
 * the session is new or being put back after a pod restart.
 */
async function launchAgent(
  meta: Meta,
  projectDir: string,
  base: string,
  opts: LaunchOptions = {},
): Promise<void> {
  const extraEnv = await agentEnv();
  // The session's headless browser (launched on demand, see browser.ts): the
  // agent connects playwright to VK_BROWSER_CDP to test in a browser the user
  // can watch in the UI. POST /api/sessions/$VK_SESSION_ID/browser/start boots
  // it if nothing is connected yet.
  extraEnv.VK_SESSION_ID = meta.id;
  // A repo's own core.hooksPath (husky sets one) outranks the system-wide one
  // the attribution stripper is installed with, so in such a repo it never
  // ran. Configuration given in the environment outranks the repo's, and the
  // shipped hooks run the repo's own, husky's included (runtime/git-hooks).
  extraEnv.GIT_CONFIG_COUNT = "1";
  extraEnv.GIT_CONFIG_KEY_0 = "core.hooksPath";
  extraEnv.GIT_CONFIG_VALUE_0 = "/etc/verksted/git-hooks";
  extraEnv.VK_BROWSER_CDP = `http://127.0.0.1:${meta.cdpPort ?? (await cdpPortFor(meta.id))}`;
  let command = base;
  if (meta.agent === "claude") {
    // Status hooks: claude writes waiting/running into the session state file
    // and its conversation id into the conv file. MCP config: the playwright
    // MCP drives the session browser.
    const settings = await ensureHooksSettings(!!opts.unattended);
    command += ` --settings "${settings}" --mcp-config "${await ensureMcpConfig()}"`;
    extraEnv.VK_SETTINGS = settings;
    extraEnv.VK_STATE_FILE = statePath(meta.id);
    extraEnv.VK_CONV_FILE = convPath(meta.id);
    extraEnv.VK_REPORT_FILE = reportPath(meta.id);
    if (opts.unattended) {
      // Headless rather than the TUI: the prompt is an argument rather than
      // keystrokes into an input box, the process exits when the turn is done,
      // and --max-turns is a cap the TUI has no equivalent of. The pane keeps
      // its shell afterwards (tmux.newSession), so what claude printed can
      // still be read, and the transcript lands under $HOME like any other.
      command += ` --permission-mode dontAsk --max-turns ${UNATTENDED_MAX_TURNS} --verbose -p`;
      // What the guard hook reads (runtime/vk-guard): which stage's rules
      // apply, and the one directory the run may change.
      extraEnv.VK_UNATTENDED = "1";
      extraEnv.VK_STAGE = opts.unattended;
      extraEnv.VK_PROJECT = meta.project;
      extraEnv.VK_WORKTREE = projectDir;
      extraEnv.VK_EXIT_FILE = exitPath(meta.id);
      if (opts.issue) extraEnv.VK_ISSUE = String(opts.issue);
    } else if (opts.autoPermissions) {
      command += " --permission-mode auto";
    }
  }
  // The prompt travels in the session environment, never in the command: tmux
  // gets it as an execFile argument, and the pane's shell only ever sees the
  // quoted expansion, so no character in it can be read as shell syntax.
  if (opts.prompt) {
    const context = await projectContext(projectDir);
    extraEnv.VK_PROMPT = context ? `${context}\n\n---\n\n${opts.prompt}` : opts.prompt;
    command += ' "$VK_PROMPT"';
  }
  // The pane records that the agent is gone, and how it went, before it drops
  // into the shell that keeps the session readable (see tmux.newSession).
  //
  // vk-signoff runs between the two: a run that finished and never wrote its
  // verdict is asked for it, in the conversation it just had. Before the exit
  // file rather than after, because that file is what tells the watcher the
  // session may be ended — written first, the pane would be killed mid-ask.
  if (opts.unattended) {
    command += '; vk_code=$?; vk-signoff "$vk_code"; printf %s "$vk_code" > "$VK_EXIT_FILE"';
  }

  await handOverSidecars(meta.id);
  await tmux.newSession(meta.id, projectDir, command, extraEnv);
}

/**
 * The files a session writes from inside its pane: its state, its
 * conversation id, its verdict and its exit code. Under the agent user it
 * cannot make a file in this directory, which is the backend's, so they are
 * made here and handed over. Opened for append, so what an earlier run of the
 * same session wrote is kept. A no-op without an agent user.
 */
async function handOverSidecars(id: string): Promise<void> {
  if (!agentUser() || !SESSION_ID_RE.test(id)) return;
  const files = [statePath(id), convPath(id), reportPath(id), exitPath(id)];
  for (const file of files) await (await fs.open(file, "a")).close();
  await giveToAgent(...files);
}

/**
 * An unattended run the restart ended. Returned rather than announced from
 * here: the notifier imports this store, and it learns of a session by seeing
 * its status change, which it cannot for one that ended while it was not
 * running. Without this the night's failure was in the inbox and nowhere else.
 */
export interface RestartFailure {
  id: string;
  title: string;
  project: string;
}

const RESTARTED = "failed: the pod restarted mid-run";

/**
 * Put sessions that were still live back on a fresh tmux server, after the pod
 * restarted out from under them. The tmux server dies with the container, but
 * everything the session actually is outlives it on the volume: its metadata
 * here and its conversation in the agent's own $HOME. Resuming the recorded
 * conversation by id is the whole point — `--continue` picks the newest
 * conversation for a directory, so two sessions in one project would both land
 * on the same one. A session with no recorded id is left to the list sweep,
 * which ends it as before.
 */
export async function restoreSessions(log: Logger): Promise<RestartFailure[]> {
  const failed: RestartFailure[] = [];
  await sweepTempFiles(env.SESSIONS_DIR);
  const live = await liveNames();
  if (live === null) {
    // Restoring on a guess would start a second agent for every session that is
    // actually still running.
    log.warn({}, "tmux unreachable at boot; skipping session restore");
    return failed;
  }
  for (const meta of await readAll()) {
    if (meta.endedAt || live.has(meta.id) || meta.agent !== "claude") continue;
    if (meta.unattended) {
      // Not resumed: nobody is there to pick it up, and a resumed conversation
      // would come back without the flags that made it unattended. Failed
      // instead, in its own words, so the inbox says the pod went down rather
      // than nothing — the sweep ends it like any other session tmux lost.
      await writeReport(meta.id, RESTARTED);
      log.info(`unattended session ${meta.id} ${RESTARTED}`);
      failed.push({ id: meta.id, title: meta.title, project: meta.project });
      continue;
    }
    const conv = await readConv(meta.id);
    if (!conv) continue;
    try {
      await launchAgent(meta, sessionDir(meta), `claude --resume ${conv}`);
      log.info(`restored session ${meta.id} on conversation ${conv}`);
    } catch (err) {
      // A deleted project dir or a tmux that would not start: leave it to be
      // swept as done rather than failing the whole boot.
      log.warn(err, `could not restore session ${meta.id}`);
    }
  }
  return failed;
}

/**
 * Serializes createSession. The sequence number is read from the metadata on
 * disk and written back by the same call, so two concurrent creates in one
 * project both see the same highest seq and mint the same id: the second tmux
 * new-session fails, and whichever metadata lands last wins. Creating a session
 * is rare and already costs a git sync and a process spawn, so a plain queue is
 * the right size of fix — the alternative, a lock file on the volume, buys
 * nothing while there is one backend process.
 */
let createQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = createQueue.then(fn, fn);
  createQueue = run.catch(() => {});
  return run;
}

/**
 * The highest sequence number each project has ever used (R-05).
 *
 * The metadata on disk cannot answer this: a purged session takes its number
 * with it, and the next create mints the same id again. The id is the join key
 * between the metadata, tmux, the transcript, the usage file and the feed —
 * `bench:wait:<id>` — and a schedule's run history stores it too. So a purged
 * scheduled run followed by an interactive session with the recycled id had
 * the scheduler reading that night's run as "still open", and a day later
 * writing "failed: never signed off" into somebody's live session and ending
 * it.
 *
 * One small file beside the metadata, written inside the create queue, so the
 * numbers only ever go up. `readAll` skips it: it is not `<session id>.json`.
 */
function seqPath(): string {
  return path.join(env.SESSIONS_DIR, "seq.json");
}

async function highWater(): Promise<Record<string, number>> {
  try {
    return JSON.parse(await fs.readFile(seqPath(), "utf8")) as Record<string, number>;
  } catch {
    // No file yet, or one written before this existed: the metadata on disk is
    // the floor, which is exactly what the old behaviour used on its own.
    return {};
  }
}

async function nextSeq(project: string, metas: Meta[]): Promise<number> {
  const mark = (await highWater())[project];
  const onDisk = metas
    .filter((m) => m.project === project)
    .reduce((max, m) => Math.max(max, Number(m.id.split("-").at(-1))), 0);
  return Math.max(Number.isFinite(mark) ? Number(mark) : 0, onDisk) + 1;
}

/**
 * Written once the session is really running, not when the number is minted:
 * a create that failed to launch leaves nothing behind that could collide, and
 * a bench that burned a number on every failed tmux would be a worse record
 * than the one it replaces.
 */
async function markSeq(project: string, seq: number): Promise<void> {
  const high = await highWater();
  if ((high[project] ?? 0) >= seq) return;
  await writeJsonAtomic(seqPath(), { ...high, [project]: seq });
}

export function createSession(
  project: string,
  projectDir: string,
  agent: AgentName,
  opts: LaunchOptions = {},
): Promise<CreatedSession> {
  return serialized(async () => {
    const extraEnv = await agentEnv();
    // Start the agent from an up-to-date default branch. Reported back to the
    // UI: it is a no-op on a worktree or a dirty tree, and the user has to know.
    const sync = await syncDefaultBranch(projectDir, extraEnv);
    // Inside the queue, so two creates cannot both see room for one. A tmux
    // that cannot be counted is about to fail the launch anyway.
    const live = await liveNames();
    if (live && live.size >= MAX_LIVE_SESSIONS) {
      throw new LimitError(`${MAX_LIVE_SESSIONS} sessions are already running; end one first`);
    }
    const metas = await readAll();
    const seq = await nextSeq(project, metas);
    // Against the project as it resolves: `projectDir` has been through realpath.
    const under = path.relative(resolveInsideRepos(project), projectDir);
    const meta: Meta = {
      id: `vk-${project}-${seq}`,
      project,
      ...(under && !under.startsWith("..") ? { cwd: under } : {}),
      agent,
      title: opts.title?.trim() || `${agent}-${seq}`,
      createdAt: new Date().toISOString(),
      endedAt: null,
      cdpPort: nextCdpPort(usedCdpPorts(metas)),
      // Read after the sync above, so the branch the app just fast-forwarded is
      // the baseline and only what the session does counts against it.
      startCommit: await headCommit(projectDir),
      ...(opts.unattended ? { unattended: opts.unattended } : {}),
    };
    // Belt and braces beside the high-water mark above: a file left by a
    // session that shared this id before the mark existed.
    await fs.rm(statePath(meta.id), { force: true });
    await fs.rm(convPath(meta.id), { force: true });
    await fs.rm(reportPath(meta.id), { force: true });
    await fs.rm(exitPath(meta.id), { force: true });
    // Metadata first: a tmux session the app has no record of is invisible in
    // the UI and never reaped, so it can only be found with kubectl exec.
    await writeMeta(meta);
    try {
      await launchAgent(
        meta,
        projectDir,
        (opts.resume && RESUME_COMMANDS[agent]) || AGENT_COMMANDS[agent],
        opts,
      );
    } catch (err) {
      // Nothing started, so leave no session behind for the UI to show as live.
      await fs.rm(metaPath(meta.id), { force: true });
      throw err;
    }
    await markSeq(project, seq);
    return { ...(await toSession(meta, true, null)), sync };
  });
}
