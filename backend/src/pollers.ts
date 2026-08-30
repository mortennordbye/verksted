import type { MaintainerIssue, Memory, ScheduleRun, Session } from "../../shared/api.js";
import * as feed from "./feed-store.js";
import type { Seen } from "./feed-store.js";
import { ghNotifications, type Notification } from "./gh.js";
import { listQueue } from "./maintainer.js";
import { listProposals } from "./memory-store.js";
import { resolveInsideRepos } from "./paths.js";
import { listRuns, listSchedules } from "./schedules-store.js";
import { listSessions } from "./sessions-store.js";

/**
 * The pollers: what turns a source into feed items.
 *
 * A poller never calls a model. It reads a source, files what it finds under
 * the source's own ids, and resolves what is over; judgement is the triage
 * turn's. That is what keeps a source free while nothing happens, and one
 * batched call when something does.
 *
 * Two kinds. The bench's own lists are on this volume and cheap, so they are
 * read on demand, every time the feed is opened — no timer to be behind, and
 * nothing to seed in a test. The remote ones (GitHub, and later mail) run on a
 * timer and keep a cursor in the items themselves: the version each item
 * carries is what the poller saw last, so a restart re-reading the source
 * finds everything already filed.
 */
interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** A session that stopped to ask: one item while it waits, done when answered. */
export function sessionItems(sessions: Session[]): { seen: Seen[]; over: string[] } {
  const seen: Seen[] = [];
  const over: string[] = [];
  for (const s of sessions) {
    const id = `bench:wait:${s.id}`;
    if (s.status === "waiting") {
      seen.push({
        id,
        source: "bench",
        at: new Date().toISOString(),
        title: `${s.project}: ${s.title}`,
        detail: s.report ?? "waiting for an answer",
        link: `/s/${s.id}`,
        version: "waiting",
        // A session blocked on you is attention by definition; triage adds
        // the summary, not the verdict.
        urgency: "attention",
      });
    } else {
      over.push(id);
    }
  }
  return { seen, over };
}

/** Every firing, so the brief can count the quiet ones; only the bad ones shout. */
export function runItems(runs: ScheduleRun[]): Seen[] {
  return runs.map((r) => ({
    id: `schedule:${r.scheduleId}:${r.at}`,
    source: "schedule",
    at: r.at,
    title: r.schedule,
    detail: r.report ?? r.error ?? "no sign-off",
    link: r.sessionId ? `/s/${r.sessionId}` : "/runs",
    version: `${r.outcome}:${(r.report ?? r.error ?? "").length}`,
    urgency: r.outcome === "attention" || r.outcome === "failed" ? "attention" : "quiet",
  }));
}

/** A proposed memory waits for a keep or a drop; either ends the item. */
export function proposalItems(proposals: Memory[]): Seen[] {
  return proposals.map((p) => ({
    id: `memory:${p.slug}`,
    source: "memory",
    at: p.createdAt ?? new Date().toISOString(),
    title: `proposed: ${p.text.length > 80 ? `${p.text.slice(0, 79)}…` : p.text}`,
    detail: p.source ?? "",
    link: "/runs",
    version: p.slug,
    urgency: "new",
  }));
}

/** The maintainer's queue: the repo's own issues, one item while each is open. */
export function queueItems(issues: MaintainerIssue[]): Seen[] {
  return issues.map((i) => ({
    id: `github:queue:${i.project}#${i.number}`,
    source: "github",
    at: i.updatedAt,
    title: `${i.project} #${i.number}: ${i.title}`,
    detail: `${i.state}${i.tier ? `, tier:${i.tier}` : ""} on the maintainer's queue`,
    link: i.url,
    version: `${i.state}:${i.updatedAt}`,
    urgency: "quiet",
  }));
}

/** A notification's API url, as the page a person opens. */
export function htmlUrl(n: Notification): string {
  const m = /repos\/([^/]+\/[^/]+)\/(pulls|issues|commits|releases)\/([^/]+)$/.exec(
    n.subject.url ?? "",
  );
  if (!m) return n.repository.html_url;
  const kind = m[2] === "pulls" ? "pull" : m[2] === "commits" ? "commit" : m[2];
  return `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

const REASON: Record<string, string> = {
  review_requested: "your review was asked for",
  mention: "you were mentioned",
  assign: "assigned to you",
  author: "on something you opened",
  comment: "a new comment",
  ci_activity: "a workflow run",
  state_change: "state changed",
  subscribed: "on something you watch",
  team_mention: "your team was mentioned",
};

export function notificationItems(threads: Notification[]): Seen[] {
  return threads.map((n) => ({
    id: `github:${n.id}`,
    source: "github",
    at: n.updated_at,
    title: `${n.repository.full_name}: ${n.subject.title}`,
    detail: `${n.subject.type}, ${REASON[n.reason] ?? n.reason}`,
    link: htmlUrl(n),
    version: n.updated_at,
  }));
}

/** File what a source says now, and end what it no longer says. */
async function apply(seen: Seen[], over: string[] = [], why = "over"): Promise<number> {
  let changed = 0;
  for (const s of seen) if ((await feed.upsert(s)).changed) changed++;
  for (const id of over) await feed.resolve(id, why);
  return changed;
}

/**
 * The bench's own lists, read now. Cheap enough to run every time the feed is
 * opened, which is also what makes the feed correct in a test with no timers.
 */
export async function pollBench(): Promise<number> {
  const [sessions, runs, proposals] = await Promise.all([
    listSessions(),
    listRuns(),
    listProposals(),
  ]);
  const { seen, over } = sessionItems(sessions);
  let changed = await apply(seen, over, "answered");
  changed += await apply(runItems(runs));
  // A proposal that is gone was kept or dropped; either way it is over.
  const open = new Set(proposals.map((p) => `memory:${p.slug}`));
  const gone = (await feed.list())
    .filter((i) => i.source === "memory" && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  changed += await apply(proposalItems(proposals), gone, "reviewed");
  return changed;
}

/** The maintainer's queues, which need gh and so run on the timer. */
export async function pollQueue(log: Logger): Promise<number> {
  const projects = new Set(
    (await listSchedules()).filter((s) => s.stage && s.project).map((s) => s.project),
  );
  const issues: MaintainerIssue[] = [];
  for (const project of projects) {
    try {
      issues.push(...(await listQueue(resolveInsideRepos(project), project)));
    } catch (err) {
      log.warn(err, `maintainer queue for ${project} unavailable`);
    }
  }
  const open = new Set(queueItems(issues).map((i) => i.id));
  const gone = (await feed.list())
    .filter((i) => i.id.startsWith("github:queue:") && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  return apply(queueItems(issues), gone, "off the queue");
}

/**
 * GitHub's notifications for the account. When it cannot be read, one item
 * says so and the poller backs off rather than filing the same failure every
 * five minutes.
 */
let githubBackoff = 0;

export async function pollGithub(log: Logger): Promise<number> {
  if (githubBackoff > 0) {
    githubBackoff--;
    return 0;
  }
  try {
    const threads = await ghNotifications();
    await feed.resolve("github:poller", "reading again");
    return apply(notificationItems(threads));
  } catch (err) {
    githubBackoff = 6;
    const message = err instanceof Error ? err.message : String(err);
    log.warn(err, "github notifications unavailable");
    await feed.upsert({
      id: "github:poller",
      source: "github",
      at: new Date().toISOString(),
      title: "GitHub could not be read",
      detail: message.slice(0, 200),
      link: "/settings",
      version: message.slice(0, 200),
      urgency: "new",
    });
    return 0;
  }
}

const GITHUB_EVERY_MS = 5 * 60_000;

/** The timers, for the sources that are not on this volume. */
export function startPollers(log: Logger): void {
  const tick = async () => {
    try {
      const n = (await pollGithub(log)) + (await pollQueue(log));
      if (n) log.info(`feed: ${n} item(s) from github`);
    } catch (err) {
      log.warn(err, "github poll failed");
    }
  };
  void tick();
  setInterval(() => void tick(), GITHUB_EVERY_MS).unref?.();
}
