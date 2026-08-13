import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentName,
  CreatedSession,
  ReviewVerdict,
  Session,
  SessionReview,
  SessionWork,
} from "../../shared/api.js";
import { sweepTempFiles, writeJsonAtomic } from "./atomic-json.js";
import { closeBrowser, nextCdpPort } from "./browser.js";
import { ensureHooksSettings, ensureMcpConfig } from "./claude-hooks.js";
import { env } from "./env.js";
import { headCommit, syncDefaultBranch, workSince } from "./git.js";
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
  /** HEAD when the session started; absent for a project that is not a repo. */
  startCommit?: string | null;
  /** HEAD when the session was first seen finished, pinned at the same moment
   *  the work counts were. Without it a review of an old session would diff
   *  against wherever the repo has since got to. Absent on older metas. */
  endCommit?: string | null;
  /** Measured once, when the session is first seen finished. */
  work?: SessionWork | null;
  /** Files of the range marked read, and where the reader landed on the run as
   *  a whole. Absent until somebody reviews it. */
  reviewed?: string[];
  verdict?: ReviewVerdict | null;
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
 * listSessions is a GET that writes, and three pollers call it at once, so the
 * write has to be atomic — see writeJsonAtomic for what a torn one costs.
 */
async function writeMeta(meta: Meta): Promise<void> {
  await writeJsonAtomic(metaPath(meta.id), meta);
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
async function liveNames(): Promise<Map<string, tmux.SessionActivity> | null> {
  try {
    return new Map((await tmux.listSessionsDetail()).map((d) => [d.name, d]));
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

async function toSession(
  meta: Meta,
  live: boolean,
  state: string | null,
  activity?: tmux.SessionActivity,
): Promise<Session> {
  const {
    cdpPort: _cdpPort,
    startCommit: _startCommit,
    endCommit: _endCommit,
    reviewed: _reviewed,
    verdict: _verdict,
    ...wire
  } = meta;
  const status = !live ? "done" : state === "waiting" ? "waiting" : "running";
  const report = await readReport(meta.id);
  return {
    ...wire,
    work: meta.work ?? null,
    status,
    idleSeconds: activity ? Math.max(0, Math.round(Date.now() / 1000 - activity.activity)) : null,
    report,
    outcome: reportOutcome(report, live),
    // A count, not the paths: this rides on every row of every list, and the
    // screen that needs the paths asks for the range anyway.
    review: { reviewed: meta.reviewed?.length ?? 0, verdict: meta.verdict ?? null },
  };
}

/**
 * What the repo has to show for the session, measured the moment it is first
 * seen finished — the evidence beside its one-line sign-off, so "ok: tidied the
 * PRs" can be checked against whether anything was committed at all.
 *
 * Measured on the way out rather than on demand because the repo keeps moving:
 * the next session's commits would otherwise be added to this one's every time
 * the row was read.
 */
async function captureWork(
  meta: Meta,
): Promise<{ work: SessionWork | null; endCommit: string | null }> {
  if (!meta.startCommit) return { work: null, endCommit: null };
  try {
    const dir = resolveInsideRepos(meta.project);
    // Both taken here, at the same moment and for the same reason: the counts
    // and the range they stand for have to describe the same window.
    return { work: await workSince(dir, meta.startCommit), endCommit: await headCommit(dir) };
  } catch {
    // The project has been deleted out from under it; there is nothing to read.
    return { work: null, endCommit: null };
  }
}

/**
 * The commit range to review a session by: where the repo was when it started,
 * and where it was when it finished (HEAD while it still runs).
 *
 * Null when there is no range to read — an unknown session, or one that started
 * somewhere that is not a git repo.
 */
export async function sessionRange(id: string): Promise<{ from: string; to: string } | null> {
  const meta = await readMeta(id);
  if (!meta?.startCommit) return null;
  return { from: meta.startCommit, to: meta.endCommit ?? "HEAD" };
}

/** What has been read of a session's range, and what was concluded about it. */
export async function getReview(id: string): Promise<SessionReview> {
  const meta = await readMeta(id);
  return {
    files: meta?.reviewed ?? [],
    reviewed: meta?.reviewed?.length ?? 0,
    verdict: meta?.verdict ?? null,
  };
}

/**
 * Record a step of a review: one file marked read or unread, a verdict on the
 * run, or both. Null for either leaves that half alone; null `verdict` clears
 * it, which is how an answer is taken back.
 *
 * Read marks live in the session's own metadata rather than the browser's,
 * because the run being reviewed was started on one device and is read on
 * another — a night's work is judged on a phone and finished at a desk.
 */
export async function setReview(id: string, change: ReviewChange): Promise<SessionReview | null> {
  // Wait for this session's previous write, whether it worked or not: what
  // matters is only that no two of them read the file at the same moment.
  const queued = (reviewWrites.get(id) ?? Promise.resolve()).then(
    () => writeReview(id, change),
    () => writeReview(id, change),
  );
  reviewWrites.set(id, queued);
  try {
    return await queued;
  } finally {
    // Last one out clears the entry, so the map does not keep a key per session
    // for the life of the process.
    if (reviewWrites.get(id) === queued) reviewWrites.delete(id);
  }
}

interface ReviewChange {
  file?: { path: string; read: boolean };
  verdict?: ReviewVerdict | null;
}

/**
 * In-flight review writes, one chain per session.
 *
 * Every write is read-modify-write on a single metadata file, and the actions
 * that produce them arrive in bursts — ticking four files off as fast as a
 * thumb moves. Run concurrently they all read the same meta and the last to
 * finish wins, so three of those four marks vanish. Chaining is enough here:
 * this is one person reviewing one run, not a contended resource.
 */
const reviewWrites = new Map<string, Promise<SessionReview | null>>();

async function writeReview(id: string, change: ReviewChange): Promise<SessionReview | null> {
  const meta = await readMeta(id);
  if (!meta) return null;
  if (change.file) {
    const kept = (meta.reviewed ?? []).filter((p) => p !== change.file!.path);
    // A range shows at most MAX_FILES files, so anything approaching this is a
    // client inventing paths rather than a person reading a big night's work.
    meta.reviewed = change.file.read ? [...kept, change.file.path].slice(-1000) : kept;
  }
  if (change.verdict !== undefined) meta.verdict = change.verdict;
  await writeMeta(meta);
  return {
    files: meta.reviewed ?? [],
    reviewed: meta.reviewed?.length ?? 0,
    verdict: meta.verdict ?? null,
  };
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
      const done = await captureWork(m);
      m.work = done.work;
      m.endCommit = done.endCommit;
      await writeMeta(m);
      await closeBrowser(m.id);
    }
    // A shell companion must not outlive its agent session.
    if (!live.has(m.id) && live.has(`${m.id}-shell`)) {
      await killQuietly(`${m.id}-shell`);
    }
    const alive = live.get(m.id);
    out.push(await toSession(m, !!alive, alive ? await readState(m.id) : null, alive));
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
  return await toSession(meta, isLive, isLive ? await readState(id) : null, live?.get(id));
}

/**
 * What a session is asked to leave behind when it finishes.
 *
 * Only the agent knows whether "two PRs open" is fine or needs a person, so it
 * writes the verdict itself and everything downstream reads it: "ok:" keeps the
 * phone quiet, the other two push. Appended to the prompt rather than buried in
 * a hook because the agent has to be told in words.
 *
 * The wording is deliberately lopsided, because the failure mode in practice is
 * only ever in one direction. "attention" used to say "if I have to act", and
 * an agent that had finished a piece of work and left something to read decided
 * that reading it counted — so runs that were simply *done* arrived as "needs a
 * look" and woke a phone for a list nobody was blocked on. Every escalation
 * word therefore has to earn itself against a stated default, and the default
 * is "ok". A run that cries wolf costs more than one that under-reports: the
 * work is still on the hub either way, and an inbox of false alarms is one
 * nobody reads.
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
  '\n\nWhen you are done, write one line to the file at "$VK_REPORT_FILE", ' +
  "starting with one of three words.\n\n" +
  '"failed: <summary>" if you could not finish what you were asked.\n' +
  '"attention: <summary>" only if this cannot go any further without me — a ' +
  "decision that is not yours to make, an approval you could not get, or " +
  "something broken I would want to know about tonight.\n" +
  '"ok: <summary>" for everything else.\n\n' +
  'Work you finished and left for me to read is "ok", even when the summary is ' +
  "a list I will want to do something about later — having something to read is " +
  'not the same as being stuck. "attention" wakes a phone, so spend it only on ' +
  'a run that is actually blocked. When the two seem equally true, write "ok".';

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
  await sweepTempFiles(env.SESSIONS_DIR);
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
      // Read after the sync above, so the branch the app just fast-forwarded is
      // the baseline and only what the session does counts against it.
      startCommit: await headCommit(projectDir),
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
  // Already measured when the list sweep stamped this session's end; ending an
  // ended session must not re-measure it against a repo that has moved on.
  let work = stored?.work ?? null;
  let endCommit = stored?.endCommit ?? null;
  if (stored && !stored.work) ({ work, endCommit } = await captureWork(stored));
  if (stored) await writeMeta({ ...stored, endedAt, work, endCommit });
  return { ...session, endedAt, work, status: "done" };
}

/**
 * How long a session has to have been a bare shell before the sweep ends it.
 * Long enough that a pane still being read is never pulled out from under
 * someone, short enough that a night of finished runs is not still holding
 * slots the scheduler needs in the morning.
 */
export const REAP_IDLE_MS = 2 * 60 * 60_000;

/**
 * Whether the agent this pane was started for has exited.
 *
 * tmux runs the agent as `<agent>; exec $SHELL`, so the pane process is the
 * shell in both cases and its command name says nothing (see SessionActivity).
 * What says everything is the child: while the agent runs — including while it
 * is running a tool — the shell has one, and when it exits the pane is left as
 * an interactive shell with none.
 */
async function agentGone(panePid: number): Promise<boolean> {
  try {
    const children = await fs.readFile(`/proc/${panePid}/task/${panePid}/children`, "utf8");
    return children.trim() === "";
  } catch {
    // No such process, or a kernel without CONFIG_PROC_CHILDREN. Neither is
    // evidence that the agent is gone, and this decision ends sessions.
    return false;
  }
}

/**
 * End sessions whose agent has finished and left the pane sitting at a shell.
 *
 * These are invisible as anything but "running": the pane outlives the agent on
 * purpose (a crashed agent has to stay readable, and its shell is where you
 * restart it), so a session whose work ended at 02:00 still reads as live at
 * noon and still counts against the scheduler's live-session ceiling. Ending it
 * here is the same end DELETE performs — the report, the commit range and the
 * history all survive; only the idle pane goes.
 *
 * Deliberately narrow. Nothing is ended that is:
 *
 * - **waiting** — that is a question addressed to a person, and the inbox's
 *   business, not a sweep's.
 * - **still running an agent** — a live child means work in progress, however
 *   quiet the pane has been.
 * - **holding uncommitted or unpushed work** — the volume is the only copy, and
 *   discarding what git cannot get back is not a housekeeping decision. Those
 *   are reported instead, and left exactly where they are.
 */
export async function reapFinishedSessions(log: Logger): Promise<string[]> {
  const live = await liveNames();
  if (live === null) return []; // tmux unreachable: sweep nothing, as elsewhere.
  const ended: string[] = [];
  for (const meta of await readAll()) {
    if (meta.endedAt) continue;
    const activity = live.get(meta.id);
    if (!activity) continue; // Already gone; the list sweep stamps its end.
    if (Date.now() - activity.activity * 1000 < REAP_IDLE_MS) continue;
    if ((await readState(meta.id)) === "waiting") continue;
    if (!(await agentGone(activity.panePid))) continue;

    const { work } = await captureWork(meta);
    if (work && (work.dirty > 0 || (work.unpushed ?? 0) > 0)) {
      log.warn(
        { session: meta.id, dirty: work.dirty, unpushed: work.unpushed },
        `${meta.id} finished with work only on the volume; leaving it open`,
      );
      continue;
    }
    await endSession(meta.id);
    ended.push(meta.id);
    const idleHours = Math.round((Date.now() - activity.activity * 1000) / 3_600_000);
    log.info(`ended ${meta.id}: its agent had exited, pane idle ${idleHours}h`);
  }
  return ended;
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
