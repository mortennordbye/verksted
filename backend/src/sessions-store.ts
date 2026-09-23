import fs from "node:fs/promises";
import path from "node:path";
import type {
  AgentName,
  MaintainerStage,
  ReviewVerdict,
  Session,
  SessionReview,
  SessionUsage,
  SessionWork,
} from "../../shared/api.js";
import { reportVerdict } from "./report-verdict.js";
import { jsonIds, writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { closeBrowser, nextCdpPort } from "./browser.js";
import { env } from "./env.js";
import { headCommit, workSince } from "./git.js";
import { resolveInsideRepos } from "./paths.js";
import { keyedQueue } from "./serial.js";
import * as tmux from "./tmux.js";
import { usageOf } from "./usage.js";
import { transcriptPath } from "./claude-home.js";

export const AGENT_COMMANDS: Record<AgentName, string> = {
  claude: "claude",
  antigravity: "agy",
  codex: "codex",
};

// Agents with a "pick up the previous conversation" flag. Conversation state
// lives in $HOME on the PVC, so this survives pod restarts. codex's and agy's
// were read from their --help on the pod (codex-cli 0.155.1, agy 1.2.8);
// `codex resume --last` keeps to the directory it is started in.
export const RESUME_COMMANDS: Partial<Record<AgentName, string>> = {
  claude: "claude --continue",
  codex: "codex resume --last",
  antigravity: "agy --continue",
};

/** Each agent's command to carry on one conversation by id, after a restart. */
export const RESTORE_COMMANDS: Record<AgentName, (id: string) => string> = {
  claude: (id) => `claude --resume ${id}`,
  codex: (id) => `codex resume ${id}`,
  antigravity: (id) => `agy --conversation ${id}`,
};

export const SESSION_ID_RE = /^vk-[A-Za-z0-9._-]+-\d+$/;

export interface Meta {
  id: string;
  project: string;
  /**
   * Where it runs inside the project, when that is not the project's own
   * directory. A desk session belongs to "desk" and runs in `desk/<task>`, and
   * claude files a conversation under the directory it was started in: derived
   * from the project, its transcript was looked for in the wrong place, so it
   * had no chat and no usage, and a restore resumed it in the desk's root.
   */
  cwd?: string;
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

/** The directory a session runs in. Everything that reads its transcript starts here. */
export function sessionDir(s: { project: string; cwd?: string }): string {
  return resolveInsideRepos(s.project, s.cwd ?? "");
}

export function metaPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.json`);
}

// Written by the Claude Code hooks (see claude-hooks.ts): "waiting" while the
// agent needs the user, "running" otherwise. Absent = running.
export function statePath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.state`);
}

// Written by the SessionStart/UserPromptSubmit hooks: the id of the agent's own
// conversation, which lives in $HOME on the volume and so outlives the pod.
export function convPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.conv`);
}

// Written by the agent itself at the end of a scheduled run (the contract is in
// scheduler.ts): one line, "ok:" / "attention:" / "failed:" and a summary. It is
// what lets a night of unattended runs stay silent unless one needs a person.
export function reportPath(id: string): string {
  return path.join(env.SESSIONS_DIR, `${id}.report`);
}

// Written by the pane itself when an unattended agent exits (launchAgent puts
// the redirect after the claude command): the one fact the watcher needs.
export function exitPath(id: string): string {
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
  // Atomic: the list reads this file's first line on every pass, and a
  // truncated one reads as a run that wrote no verdict.
  await writeTextAtomic(reportPath(id), detail ? `${line}\n\n${detail}\n` : `${line}\n`);
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
    const text = (await fs.readFile(exitPath(id), "utf8")).trim();
    // Empty is the file handed to the agent user before the run, not an exit.
    if (!text) return null;
    const code = Number(text);
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

export async function readState(id: string): Promise<string | null> {
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

export async function readAll(): Promise<Meta[]> {
  const metas: Meta[] = [];
  const present = new Set<string>();
  // Only <session-id>.json files are metadata; the dir also holds .state
  // files and claude-hooks.json.
  for (const id of await jsonIds(env.SESSIONS_DIR, SESSION_ID_RE)) {
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
export async function writeMeta(meta: Meta): Promise<void> {
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
export async function liveNames(): Promise<Map<string, tmux.SessionActivity> | null> {
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

export async function toSession(
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
export async function captureWork(
  meta: Meta,
): Promise<{ work: SessionWork | null; endCommit: string | null }> {
  if (!meta.startCommit) return { work: null, endCommit: null };
  try {
    const dir = sessionDir(meta);
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
    return await usageOf(sessionDir(meta), conv);
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
export function usedCdpPorts(metas: Meta[]): Set<number> {
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
  return reportVerdict(report) ?? (live ? "running" : "done");
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

/**
 * Where a session's transcript is, if it has one.
 *
 * Three answers, and the difference matters at the route: `undefined` is a
 * session that does not exist, `null` is one that has written nothing to read —
 * an agent other than claude, or a session in its first seconds — and a string
 * is a path derived from the conversation id the session itself recorded.
 * Nothing a client sends takes part in building it.
 */
export async function transcriptOf(id: string): Promise<string | null | undefined> {
  const session = await getSession(id);
  if (!session) return undefined;
  const conversationId = await readConv(id);
  if (!conversationId) return null;
  try {
    return transcriptPath(sessionDir(session), conversationId);
  } catch {
    // The project has been deleted; there is no cwd to derive a path from.
    return null;
  }
}
