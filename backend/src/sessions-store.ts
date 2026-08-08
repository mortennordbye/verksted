import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentName, CreatedSession, Session } from "../../shared/api.js";
import { closeBrowser, nextCdpPort } from "./browser.js";
import { ensureHooksSettings, ensureMcpConfig } from "./claude-hooks.js";
import { env } from "./env.js";
import { syncDefaultBranch } from "./git.js";
import { resolveInsideRepos } from "./paths.js";
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

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

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

// Written by the SessionStart/UserPromptSubmit hooks: the id of the agent's own
// conversation, which lives in $HOME on the volume and so outlives the pod.
function convPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.conv`);
}

// Written by the agent itself at the end of a scheduled run (the contract is in
// scheduler.ts): one line, "ok:" / "attention:" / "failed:" and a summary. It is
// what lets a night of unattended runs stay silent unless one needs a person.
function reportPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.report`);
}

/** The run's own verdict, first line only; null when it wrote none. */
export async function readReport(id: string): Promise<string | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const first = (await fs.readFile(reportPath(id), "utf8")).trim().split("\n")[0]?.trim();
    return first ? first.slice(0, 300) : null;
  } catch {
    return null;
  }
}

async function readState(id: string): Promise<string | null> {
  try {
    return (await fs.readFile(statePath(id), "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * A conversation id as claude writes it: a uuid. This is a security check, not
 * a sanity one — the resume command is delivered with `tmux send-keys`, which
 * types it into the pane's shell, so anything in the id is shell syntax. The
 * execFile argument array protects the tmux call, nothing protects the shell
 * behind it but this.
 */
export const CONV_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/** The recorded conversation id, or null when absent or not a plausible id. */
export async function readConv(id: string): Promise<string | null> {
  try {
    const conv = (await fs.readFile(convPath(id), "utf8")).trim();
    return CONV_ID_RE.test(conv) ? conv : null;
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

/**
 * Write-temp-then-rename, because listSessions is a GET that writes and three
 * pollers call it at once. A plain writeFile lets two writers interleave into
 * truncated JSON, which readAll then skips silently — the session disappears
 * from history for good. rename(2) is atomic within a filesystem, so a reader
 * sees either the old file or the new one.
 *
 * The temp name cannot end in ".json", or readAll would try to parse it.
 */
async function writeMeta(meta: Meta): Promise<void> {
  const target = metaPath(meta.id);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(meta, null, 2));
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/** Leftover temp files from a pod killed mid-write; called once at boot. */
async function sweepTempMetas(): Promise<void> {
  try {
    const files = await fs.readdir(env.SESSIONS_DIR);
    for (const f of files.filter((f) => f.endsWith(".tmp"))) {
      await fs.rm(path.join(env.SESSIONS_DIR, f), { force: true });
    }
  } catch {
    // Nothing to sweep, or the dir is unreadable — boot regardless.
  }
}

async function readMeta(id: string): Promise<Meta | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    return JSON.parse(await fs.readFile(metaPath(id), "utf8")) as Meta;
  } catch {
    return null;
  }
}

/**
 * Live tmux session names, or null when tmux could not be asked at all. Null
 * means "unknown", and every caller has to treat it as such rather than as
 * "nothing is running".
 */
async function liveNames(): Promise<Set<string> | null> {
  try {
    return new Set(await tmux.listSessions());
  } catch {
    return null;
  }
}

/** Kill a tmux session that may not exist; absence is the desired end state. */
async function killQuietly(name: string): Promise<void> {
  try {
    await tmux.killSession(name);
  } catch {
    // Already gone, or tmux is down and it is going with it.
  }
}

async function toSession(meta: Meta, live: boolean, state: string | null): Promise<Session> {
  const { cdpPort: _cdpPort, ...wire } = meta;
  const status = !live ? "done" : state === "waiting" ? "waiting" : "running";
  const report = await readReport(meta.id);
  return { ...wire, status, report, outcome: reportOutcome(report, live) };
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
  const live = await liveNames();
  const metas = (await readAll()).filter((m) => !project || m.project === project);
  const out: Session[] = [];
  for (const m of metas) {
    // tmux could not be asked. Report the last known state and sweep nothing:
    // ending every session here would be wrong the moment tmux comes back, and
    // it would fire a "finished" push per session on every poll until it does.
    if (live === null) {
      const wasLive = !m.endedAt;
      out.push(await toSession(m, wasLive, wasLive ? await readState(m.id) : null));
      continue;
    }
    // Sweep: a session whose tmux died without going through DELETE gets its
    // end stamped the first time anyone lists it.
    if (!m.endedAt && !live.has(m.id)) {
      m.endedAt = new Date().toISOString();
      await writeMeta(m);
      await closeBrowser(m.id);
    }
    // A shell companion must not outlive its agent session.
    if (!live.has(m.id) && live.has(`${m.id}-shell`)) {
      await killQuietly(`${m.id}-shell`);
    }
    out.push(await toSession(m, live.has(m.id), live.has(m.id) ? await readState(m.id) : null));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getSession(id: string): Promise<Session | null> {
  const meta = await readMeta(id);
  if (!meta) return null;
  const live = await liveNames();
  // Unknown liveness: fall back to what the metadata last recorded, the same
  // way listSessions does, rather than reporting a live session as done.
  const isLive = live === null ? !meta.endedAt : live.has(id);
  return await toSession(meta, isLive, isLive ? await readState(id) : null);
}

/**
 * What a session is asked to leave behind when it finishes.
 *
 * Only the agent knows whether "two PRs open" is fine or needs a person, so it
 * writes the verdict itself and everything downstream reads it: "ok:" keeps the
 * phone quiet, the other two push. Appended to the prompt rather than buried in
 * a hook because the agent has to be told in words.
 *
 * Only scheduled runs are *told* this. An interactive session has no defined
 * end, and injecting the instruction as its first prompt would make the agent
 * answer a piece of bookkeeping before the user has said anything. Every
 * session can still write the file — VK_REPORT_FILE is set for all of them —
 * and any session that does now has its verdict read and surfaced, so asking
 * an agent for a sign-off mid-session works without changing how sessions
 * start.
 */
export const REPORT_CONTRACT =
  '\n\nWhen you are done, write one line to the file at "$VK_REPORT_FILE": ' +
  '"ok: <summary>" if nothing needs me, "attention: <summary>" if I have to act, ' +
  'or "failed: <summary>" if you could not finish.';

/** The three verdicts a report can open with, plus where it got to otherwise. */
export function reportOutcome(
  report: string | null,
  live: boolean,
): "ok" | "attention" | "failed" | "running" | "done" {
  if (report) {
    if (/^attention\b/i.test(report)) return "attention";
    if (/^failed\b/i.test(report)) return "failed";
    if (/^ok\b/i.test(report)) return "ok";
  }
  return live ? "running" : "done";
}

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
}

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
  extraEnv.VK_BROWSER_CDP = `http://127.0.0.1:${meta.cdpPort ?? (await cdpPortFor(meta.id))}`;
  let command = base;
  if (meta.agent === "claude") {
    // Status hooks: claude writes waiting/running into the session state file
    // and its conversation id into the conv file. MCP config: the playwright
    // MCP drives the session browser.
    command += ` --settings "${await ensureHooksSettings()}" --mcp-config "${await ensureMcpConfig()}"`;
    extraEnv.VK_STATE_FILE = statePath(meta.id);
    extraEnv.VK_CONV_FILE = convPath(meta.id);
    extraEnv.VK_REPORT_FILE = reportPath(meta.id);
    if (opts.autoPermissions) command += " --permission-mode auto";
  }
  // The prompt travels in the session environment, never in the command: tmux
  // gets it as an execFile argument, and the pane's shell only ever sees the
  // quoted expansion, so no character in it can be read as shell syntax.
  if (opts.prompt) {
    const context = await projectContext(projectDir);
    extraEnv.VK_PROMPT = context ? `${context}\n\n---\n\n${opts.prompt}` : opts.prompt;
    command += ' "$VK_PROMPT"';
  }

  await tmux.newSession(meta.id, projectDir, command, extraEnv);
}

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
export async function restoreSessions(log: Logger): Promise<void> {
  await sweepTempMetas();
  const live = await liveNames();
  if (live === null) {
    // Restoring on a guess would start a second agent for every session that is
    // actually still running.
    log.warn({}, "tmux unreachable at boot; skipping session restore");
    return;
  }
  for (const meta of await readAll()) {
    if (meta.endedAt || live.has(meta.id) || meta.agent !== "claude") continue;
    const conv = await readConv(meta.id);
    if (!conv) continue;
    try {
      await launchAgent(meta, resolveInsideRepos(meta.project), `claude --resume ${conv}`);
      log.info(`restored session ${meta.id} on conversation ${conv}`);
    } catch (err) {
      // A deleted project dir or a tmux that would not start: leave it to be
      // swept as done rather than failing the whole boot.
      log.warn(err, `could not restore session ${meta.id}`);
    }
  }
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
    const metas = await readAll();
    const seq =
      metas
        .filter((m) => m.project === project)
        .reduce((max, m) => Math.max(max, Number(m.id.split("-").at(-1))), 0) + 1;
    const meta: Meta = {
      id: `vk-${project}-${seq}`,
      project,
      agent,
      title: opts.title?.trim() || `${agent}-${seq}`,
      createdAt: new Date().toISOString(),
      endedAt: null,
      cdpPort: nextCdpPort(new Set(metas.map((m) => m.cdpPort!).filter(Boolean))),
    };
    // A purged session's id can be reused; drop any stale state from it.
    await fs.rm(statePath(meta.id), { force: true });
    await fs.rm(convPath(meta.id), { force: true });
    await fs.rm(reportPath(meta.id), { force: true });
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
    return { ...(await toSession(meta, true, null)), sync };
  });
}

/** Kill any live tmux sessions for a project and remove all its metadata files. */
export async function deleteProjectSessions(project: string): Promise<void> {
  const metas = (await readAll()).filter((m) => m.project === project);
  for (const m of metas) {
    // Unconditional: the metadata is about to go, so a tmux session that
    // outlived it could never be found again.
    await killQuietly(m.id);
    await killQuietly(`${m.id}-shell`);
    await closeBrowser(m.id);
    await fs.rm(metaPath(m.id), { force: true });
    await fs.rm(statePath(m.id), { force: true });
    await fs.rm(convPath(m.id), { force: true });
    await fs.rm(reportPath(m.id), { force: true });
  }
}

export async function endSession(id: string): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  if (session.status !== "done") await killQuietly(id);
  await killQuietly(`${id}-shell`);
  await closeBrowser(id);
  const endedAt = session.endedAt ?? new Date().toISOString();
  // Patch the stored metadata rather than rebuilding it from Session, which has
  // had cdpPort stripped by toSession. Rebuilding dropped the reserved port on
  // every end, so the pool leaked until nextCdpPort ran out and threw a bare 500.
  const stored = await readMeta(id);
  if (stored) await writeMeta({ ...stored, endedAt });
  return { ...session, endedAt, status: "done" };
}

/** End the session (tmux + shell companion) and remove it from history. */
export async function deleteSession(id: string): Promise<boolean> {
  const session = await getSession(id);
  if (!session) return false;
  if (session.status !== "done") await killQuietly(id);
  await killQuietly(`${id}-shell`);
  await closeBrowser(id);
  await fs.rm(metaPath(id), { force: true });
  await fs.rm(statePath(id), { force: true });
  await fs.rm(convPath(id), { force: true });
  await fs.rm(reportPath(id), { force: true });
  return true;
}
