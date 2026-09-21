import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentName,
  CreatedSession,
  MaintainerStage,
  ReviewVerdict,
  Session,
  SessionReview,
  SessionUsage,
  SessionWork,
} from "../../shared/api.js";
import { sweepTempFiles, writeJsonAtomic } from "./atomic-json.js";
import { closeBrowser, nextCdpPort } from "./browser.js";
import { ensureHooksSettings, ensureMcpConfig } from "./claude-hooks.js";
import { env } from "./env.js";
import { headCommit, syncDefaultBranch, workSince } from "./git.js";
import { resolveInsideRepos } from "./paths.js";
import { keyedQueue } from "./serial.js";
import { agentEnv } from "./settings-store.js";
import * as tmux from "./tmux.js";
import { usageOf } from "./usage.js";

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
  /** Measured with `work`. Absent on a session finished before it was measured
   *  at all; null on one measured and found to have no transcript. */
  usage?: SessionUsage | null;
  /** Files of the range marked read, and where the reader landed on the run as
   *  a whole. Absent until somebody reviews it. */
  reviewed?: string[];
  verdict?: ReviewVerdict | null;
  /** The maintainer stage a schedule started this as; absent otherwise. */
  unattended?: MaintainerStage;
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

// Written by the pane itself when an unattended agent exits (launchAgent puts
// the redirect after the claude command): the one fact the watcher needs.
function exitPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.exit`);
}

/**
 * Write a verdict on the run's behalf. For the two ends an unattended run can
 * reach without signing off — killed at the cap, or a pod restart out from
 * under it — where silence would otherwise read as a night that went well.
 */
export async function writeReport(id: string, line: string, detail = ""): Promise<void> {
  if (!SESSION_ID_RE.test(id)) return;
  // Only the first line is ever read back; what follows is kept for whoever
  // opens the file on the volume to find out what happened.
  await fs.writeFile(reportPath(id), detail ? `${line}\n\n${detail}\n` : `${line}\n`);
}

/**
 * The last thing an agent printed, for a run that exited without a word.
 *
 * A headless claude that could not start says why on the pane and exits, and
 * the pane is about to be ended — so this is the only moment that line can be
 * read. The pane keeps its shell after the agent, so a final prompt line is
 * dropped; what is left is usually the CLI's own error.
 */
export async function lastWords(id: string): Promise<{ line: string | null; tail: string }> {
  let tail: string;
  try {
    tail = (await tmux.capturePane(id, 60)).trimEnd();
  } catch {
    return { line: null, tail: "" };
  }
  const lines = tail
    .split("\n")
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (/[$#%>]\s*$/.test(lines.at(-1) ?? "")) lines.pop();
  const line = lines.at(-1)?.trim().slice(0, 200) ?? null;
  return { line, tail };
}

/**
 * The exit code of the session's agent, or null while it still runs. Only
 * an unattended run writes one: its headless agent ends on its own and leaves
 * the pane at a shell, so tmux alone would say the session was still going.
 * A file the pane writes rather than a guess from what tmux reports as the
 * pane's current command, which names the wrapper shell as readily as the
 * agent.
 */
export async function agentExited(id: string): Promise<number | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  try {
    const code = Number((await fs.readFile(exitPath(id), "utf8")).trim());
    return Number.isFinite(code) ? code : 1;
  } catch {
    return null;
  }
}

/**
 * The last read of each session's metadata and of the verdict beside it.
 *
 * The list is O(history) and nearly everything asks for it: the event watcher
 * every three seconds, the notifier every five, the scheduler's two watchers
 * twice a minute, and every GET of the feed, the usage page or the project
 * list. Each of those read and parsed every `<id>.json` on the volume and the
 * `<id>.report` next to it — on the pod that is 145 sessions, close to three
 * hundred reads off NFS, to answer "nothing has changed".
 *
 * A finished session's files never move again, so size and mtime settle it: a
 * hit costs one stat and no parse, which leaves the reading proportional to
 * what is still moving. The walk itself is still over the whole directory —
 * making that proportional to live sessions means retention, which the backlog
 * holds. Nothing has to be invalidated, because the test is against the file
 * and not against a clock: a meta written by this process, by `vk restore` or
 * by hand is picked up the same way, and a purged one falls out on the next
 * pass.
 */
interface Held<T> {
  size: number;
  mtimeMs: number;
  value: T;
}

const metaCache = new Map<string, Held<Meta>>();
const reportCache = new Map<string, Held<string | null>>();

async function exists(file: string): Promise<boolean> {
  return await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
}

/**
 * Read a file through its cache. Null means the file could not be read at all,
 * which is an answer here — no metadata, no verdict — and never an error.
 */
async function cached<T>(
  held: Map<string, Held<T>>,
  id: string,
  suffix: string,
  read: (file: string) => Promise<T>,
): Promise<T | null> {
  // Checked and joined here rather than handed in already built: this is the
  // one place in the module that turns a session id into a file to open, so it
  // is where the check belongs. Taking the path from the caller would also put
  // the check in one function and the open in another, which is a shape no
  // reader — and no scanner — can see the safety of.
  if (!SESSION_ID_RE.test(id)) return null;
  const file = path.join(env.SESSIONS_DIR, `${id}${suffix}`);
  try {
    const { size, mtimeMs } = await fs.stat(file);
    const hit = held.get(id);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.value;
    const value = await read(file);
    held.set(id, { size, mtimeMs, value });
    return value;
  } catch {
    held.delete(id);
    return null;
  }
}

/** Forget every cached read. For tests, which rewrite these files in place. */
export function resetSessionCache(): void {
  metaCache.clear();
  reportCache.clear();
}

/** The run's own verdict, first line only; null when it wrote none. */
export async function readReport(id: string): Promise<string | null> {
  return await cached(reportCache, id, ".report", async (file) => {
    const first = (await fs.readFile(file, "utf8")).trim().split("\n")[0]?.trim();
    return first ? first.slice(0, 300) : null;
  });
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
  const present = new Set<string>();
  // Only <session-id>.json files are metadata; the dir also holds .state
  // files and claude-hooks.json.
  for (const f of files.filter((f) => f.endsWith(".json") && SESSION_ID_RE.test(f.slice(0, -5)))) {
    const id = f.slice(0, -5);
    present.add(id);
    // Skip unreadable/corrupt metadata rather than failing the whole list.
    const meta = await readMeta(id);
    if (meta) metas.push(meta);
  }
  // A purged session must not keep its entry: this is the one pass that knows
  // the whole set, and nothing else would ever drop it.
  for (const held of [metaCache, reportCache]) {
    for (const id of held.keys()) if (!present.has(id)) held.delete(id);
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

/**
 * Whether a parsed file is metadata at all.
 *
 * `JSON.parse` is happy with `{}`, and an empty or half-written object used to
 * travel all the way to the sort at the end of the list, where an undefined
 * `createdAt` threw — taking `/api/sessions`, the event stream, the notifier,
 * the scheduler's watch and the project list down together, on every tick,
 * until someone deleted the file by hand. One bad file costs its own row now,
 * the same as one that will not parse.
 */
function isMeta(value: unknown): value is Meta {
  const m = value as Partial<Meta> | null;
  return (
    !!m &&
    typeof m === "object" &&
    typeof m.id === "string" &&
    typeof m.project === "string" &&
    typeof m.createdAt === "string"
  );
}

async function readMeta(id: string): Promise<Meta | null> {
  const meta = await cached(metaCache, id, ".json", async (file) => {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    if (!isMeta(parsed)) throw new Error(`${id}: not session metadata`);
    return parsed;
  });
  // A copy per caller: the held object is shared, and the list sweep, the
  // review and the usage backfill all assign to the meta they were handed.
  return meta && { ...meta };
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
    usage: meta.usage ?? null,
    // Absent means nobody has measured it; null means somebody did and there
    // was no transcript to read. Both arrive as null, so the fact of having
    // looked has to travel beside it.
    measured: meta.usage !== undefined,
    status,
    lastActivityAt: activity ? new Date(activity.activity * 1000).toISOString() : null,
    report,
    outcome: reportOutcome(report, live),
    // A count, not the paths: this rides on every row of every list, and the
    // screen that needs the paths asks for the range anyway.
    review: { reviewed: meta.reviewed?.length ?? 0, verdict: meta.verdict ?? null },
    unattended: meta.unattended ?? null,
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
 * What the session cost, from the transcript its conversation id names. Null
 * when there is nothing to read: no conversation was ever recorded, the
 * project is gone, or the file is not there.
 */
async function captureUsage(meta: Meta): Promise<SessionUsage | null> {
  const conv = await readConv(meta.id);
  if (!conv) return null;
  try {
    return await usageOf(resolveInsideRepos(meta.project), conv);
  } catch {
    return null;
  }
}

/**
 * One chain per session for everything that changes its metadata.
 *
 * Every change is read-modify-write over the whole record, and they overlap:
 * the sweep spends git calls and a transcript read working out how a run went
 * while a thumb ticks files off a review of it. Run beside each other, the
 * sweep writes the meta it read before the marks existed and they are gone.
 *
 * The read belongs inside the queue, which is what `updateMeta` is for.
 */
const metaWrites = keyedQueue();

/**
 * Read one session's metadata, change it, write it back, holding the id for
 * all three. Null when there is no such session, or when it was deleted while
 * the change was being worked out: a DELETE is deliberately not queued behind
 * this, because the sweep can hold a session for as long as its transcript
 * takes to read and nobody should wait that long to remove a row.
 */
async function updateMeta<T>(
  id: string,
  change: (meta: Meta) => Promise<T> | T,
): Promise<T | null> {
  return await metaWrites(id, async () => {
    const meta = await readMeta(id);
    if (!meta) return null;
    const result = await change(meta);
    if (!(await exists(metaPath(id)))) return null;
    await writeMeta(meta);
    return result;
  });
}

/**
 * Measure the sessions that finished before usage was measured at all, a few
 * at a time. Runs in the daily maintenance pass; once every old session carries
 * a measurement this finds nothing. Every path that ends a session measures it
 * there and then, so this is only ever a catch-up for history.
 */
export async function backfillUsage(limit = 25): Promise<number> {
  let n = 0;
  for (const stale of await readAll()) {
    if (!stale.endedAt) continue;
    // Measured already, unless before prices were kept: then once more.
    if (stale.usage === null || stale.usage?.costUsd !== undefined) continue;
    await updateMeta(stale.id, async (meta) => {
      meta.usage = await captureUsage(meta);
    });
    if (++n >= limit) break;
  }
  return n;
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
  // The same chain every other change to this meta runs on. The marks arrive
  // in bursts, four files ticked off as fast as a thumb moves, and they land
  // while the sweep may be working out how the run went.
  return await updateMeta(id, (meta) => {
    if (change.file) {
      const kept = (meta.reviewed ?? []).filter((p) => p !== change.file!.path);
      // A range shows at most MAX_FILES files, so anything approaching this is
      // a client inventing paths rather than a person reading a big night's
      // work.
      meta.reviewed = change.file.read ? [...kept, change.file.path].slice(-1000) : kept;
    }
    if (change.verdict !== undefined) meta.verdict = change.verdict;
    return {
      files: meta.reviewed ?? [],
      reviewed: meta.reviewed?.length ?? 0,
      verdict: meta.verdict ?? null,
    };
  });
}

interface ReviewChange {
  file?: { path: string; read: boolean };
  verdict?: ReviewVerdict | null;
}

/**
 * The ports that are actually spoken for: a session's chromium is closed when
 * the session ends, so only sessions that have not ended hold one. Counting
 * every meta on disk retired a port per session for good, and the pool is 200
 * wide — a pod that starts nine sessions a night stops being able to start any
 * after three weeks, with `createSession` throwing on the way in.
 */
function usedCdpPorts(metas: Meta[]): Set<number> {
  return new Set(metas.filter((m) => !m.endedAt && m.cdpPort).map((m) => m.cdpPort!));
}

/** The session's reserved browser CDP port, assigned lazily for pre-existing metas. */
export async function cdpPortFor(id: string): Promise<number | null> {
  // Queued with every other change to this meta: two panes opened at once used
  // to read the same record, pick the same free port, and write over each
  // other, leaving two sessions pointed at one chromium.
  return await updateMeta(id, async (meta) => {
    meta.cdpPort ??= nextCdpPort(usedCdpPorts(await readAll()));
    return meta.cdpPort;
  });
}

export async function listSessions(project?: string): Promise<Session[]> {
  const live = await liveNames();
  const metas = (await readAll()).filter((m) => !project || m.project === project);
  const out: Session[] = [];
  for (const m of metas) {
    // tmux could not be asked: report the last known state rather than calling
    // every session done, which would be wrong the moment tmux comes back.
    if (live === null) {
      const wasLive = !m.endedAt;
      out.push(await toSession(m, wasLive, wasLive ? await readState(m.id) : null));
      continue;
    }
    const alive = live.get(m.id);
    out.push(await toSession(m, !!alive, alive ? await readState(m.id) : null, alive));
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Stamp the end of every session whose tmux is gone, and reap the shells left
 * behind by one.
 *
 * What the list says about a session has never come from here: `status` is
 * decided by whether tmux has it, so a session that died a second ago already
 * reads as done. What this writes down is the rest — when it ended, what the
 * repo had to show for it, what it cost — measured once, at the end, because
 * the repo keeps moving and the next session's commits must not join this row.
 *
 * It used to run inside `listSessions`, which made it a write inside a GET:
 * git calls and a transcript read on whichever poll happened to arrive first,
 * so what the volume did depended on who was looking. It is a background job
 * now and the list only reads.
 */
export async function sweepSessions(): Promise<string[]> {
  const live = await liveNames();
  // tmux could not be asked. Sweep nothing: ending every session here would
  // fire a "finished" push per session on every tick until tmux comes back.
  if (live === null) return [];
  const ended: string[] = [];
  for (const seen of await readAll()) {
    if (!seen.endedAt && !live.has(seen.id)) {
      // Through updateMeta, which re-reads inside the queue: working out how
      // the run went takes git calls and a transcript read, and a review saved
      // in the middle of that must not be written over by the snapshot this
      // started from. It answers null when a DELETE got there first.
      const stamped = await updateMeta(seen.id, async (meta) => {
        meta.endedAt = new Date().toISOString();
        const done = await captureWork(meta);
        meta.work = done.work;
        meta.endCommit = done.endCommit;
        meta.usage = await captureUsage(meta);
        // Before the meta says ended, because that is what frees its CDP port
        // for the next session: a chromium still holding the port would make
        // that session's browser fail to bind.
        await closeBrowser(meta.id);
        return true;
      });
      if (stamped) ended.push(seen.id);
    }
    // A shell companion must not outlive its agent session.
    if (!live.has(seen.id) && live.has(`${seen.id}-shell`)) {
      await killQuietly(`${seen.id}-shell`);
    }
  }
  return ended;
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
    if (meta.unattended) {
      // Not resumed: nobody is there to pick it up, and a resumed conversation
      // would come back without the flags that made it unattended. Failed
      // instead, in its own words, so the inbox says the pod went down rather
      // than nothing — the sweep ends it like any other session tmux lost.
      await writeReport(meta.id, "failed: the pod restarted mid-run");
      log.info(`unattended session ${meta.id} failed: the pod restarted mid-run`);
      continue;
    }
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
    const metas = await readAll();
    const seq = await nextSeq(project, metas);
    const meta: Meta = {
      id: `vk-${project}-${seq}`,
      project,
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
    await fs.rm(exitPath(m.id), { force: true });
  }
}

export async function endSession(id: string): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;
  if (session.status !== "done") await killQuietly(id);
  await killQuietly(`${id}-shell`);
  await closeBrowser(id);
  const endedAt = session.endedAt ?? new Date().toISOString();
  // Patched through updateMeta rather than rebuilt from Session, which has had
  // cdpPort stripped by toSession. Rebuilding dropped the reserved port on
  // every end, so the pool leaked until nextCdpPort ran out and threw a bare
  // 500. Queued, because the sweep may be stamping this very session.
  const measured = await updateMeta(id, async (meta) => {
    meta.endedAt = endedAt;
    // Already measured when the sweep stamped this session's end; ending an
    // ended session must not re-measure it against a repo that has moved on.
    if (!meta.work) {
      const done = await captureWork(meta);
      meta.work = done.work;
      meta.endCommit = done.endCommit;
    }
    if (meta.usage === undefined) meta.usage = await captureUsage(meta);
    return { work: meta.work ?? null, usage: meta.usage ?? null };
  });
  return { ...session, endedAt, ...(measured ?? { work: null, usage: null }), status: "done" };
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

/**
 * How long a finished session stays a file of its own in the sessions
 * directory.
 *
 * Everything that reads sessions walks that directory: the sweeper every five
 * seconds, the notifier every five, the scheduler twice a minute, and every
 * list. Nothing prunes it, so the walk grows with everything that ever ran —
 * a pod three years old would be stepping over thousands of finished runs to
 * find the two that are live.
 *
 * Three months is well past the point where a run is something anyone opens,
 * and comfortably past the thirty days the usage page breaks down by project.
 */
export const RETAIN_DAYS = 90;

function archiveDir(): string {
  return path.join(env.SESSIONS_DIR, "archive");
}

/**
 * Retire the sessions that ended long enough ago, keeping what they cost.
 *
 * Archived, not deleted. The row itself is small and the usage page adds up
 * every month there has ever been, so throwing it away would make last year
 * read as a year of nothing. What goes is the per-session file and its
 * sidecars — the verdict, the exit code, the conversation id, the read marks —
 * which is what the walk is made of. The transcript is not here at all: it
 * lives in the agent's own home directory and is untouched by this.
 *
 * Written before the metadata is removed, and read back deduplicated by id, so
 * a crash between the two costs a repeated row rather than a lost one.
 */
export async function archiveOldSessions(log: Logger): Promise<number> {
  const cutoff = Date.now() - RETAIN_DAYS * 24 * 60 * 60_000;
  let n = 0;
  for (const meta of await readAll()) {
    const endedAt = meta.endedAt ? Date.parse(meta.endedAt) : NaN;
    // Not finished, or not finished long enough ago. An unparseable endedAt is
    // not evidence of age, and this removes files.
    if (!Number.isFinite(endedAt) || endedAt > cutoff) continue;
    const row = await toSession(meta, false, null);
    await fs.mkdir(archiveDir(), { recursive: true });
    // The month from the timestamp, never from the string it was parsed out
    // of. `Date.parse` takes "3/14/2026" as readily as an ISO date, and the
    // first seven characters of that are a path of their own.
    const month = new Date(endedAt).toISOString().slice(0, 7);
    await fs.appendFile(path.join(archiveDir(), `${month}.jsonl`), `${JSON.stringify(row)}\n`);
    // The metadata first: it is what the session is listed from, so once it is
    // gone the session is retired whatever happens to the rest.
    for (const file of [metaPath, statePath, convPath, reportPath, exitPath]) {
      await fs.rm(file(meta.id), { force: true });
    }
    n++;
  }
  if (n) log.info(`archived ${n} session(s) that ended more than ${RETAIN_DAYS} days ago`);
  return n;
}

/**
 * The sessions that have been retired, as they were when they were.
 *
 * Only the usage page asks: it adds up every month there has ever been, and
 * those totals are the one thing that would quietly change if history simply
 * stopped at ninety days.
 */
export async function archivedSessions(): Promise<Session[]> {
  const files = await fs.readdir(archiveDir()).catch(() => [] as string[]);
  const byId = new Map<string, Session>();
  for (const f of files.filter((f) => f.endsWith(".jsonl"))) {
    const text = await fs.readFile(path.join(archiveDir(), f), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const row = JSON.parse(line) as Session;
        // Last write wins, and a row repeated by a crash mid-retirement counts
        // once rather than twice.
        if (row?.id) byId.set(row.id, row);
      } catch {
        // One unreadable line is one session's row, not the whole archive.
      }
    }
  }
  return [...byId.values()];
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
  await fs.rm(exitPath(id), { force: true });
  return true;
}
