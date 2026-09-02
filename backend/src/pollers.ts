import type {
  CalendarEvent,
  MailSummary,
  MaintainerIssue,
  Memory,
  ScheduleRun,
  Session,
} from "../../shared/api.js";
import * as calendar from "./calendar.js";
import * as mail from "./mail.js";
import * as feed from "./feed-store.js";
import type { Seen } from "./feed-store.js";
import { ghNotifications, type Notification } from "./gh.js";
import { listQueue } from "./maintainer.js";
import { listProposals } from "./memory-store.js";
import { resolveInsideRepos } from "./paths.js";
import { listRuns, listSchedules } from "./schedules-store.js";
import { listSessions } from "./sessions-store.js";
import { readBlockedOwners } from "./settings-store.js";

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

/**
 * A run that could not authenticate, told apart from one that had nothing to do.
 *
 * Both are recorded as `blocked`, and for almost everything blocked means the
 * schedule declining: an empty queue, a previous run still open, the daily
 * ceiling. Those are quiet by design and there are several a night. This is
 * not one of them. A login that has expired stops every schedule and every
 * session at once, it will be just as true tomorrow, and nothing else on the
 * bench can report it — the assistant turn that would say so is the thing that
 * died. Filed quiet, it spent three days inside "and 6 quiet things".
 */
const CANNOT_AUTHENTICATE =
  /failed to authenticate|oauth session expired|not authenticated|invalid api key|please run `?\/login/i;

/** Every firing, so the brief can count the quiet ones; only the bad ones shout. */
export function runItems(runs: ScheduleRun[]): Seen[] {
  return runs.map((r) => {
    const said = r.report ?? r.error ?? "";
    const loud =
      r.outcome === "attention" || r.outcome === "failed" || CANNOT_AUTHENTICATE.test(said);
    return {
      id: `schedule:${r.scheduleId}:${r.at}`,
      source: "schedule" as const,
      at: r.at,
      title: r.schedule,
      detail: said || "no sign-off",
      link: r.sessionId ? `/s/${r.sessionId}` : "/runs",
      version: `${r.outcome}:${said.length}`,
      urgency: loud ? "attention" : "quiet",
    };
  });
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

/**
 * Whose repositories this bench does not read.
 *
 * An employer's org and a customer's are on GitHub under the same account as
 * the hobby work, and a notification from one carries the client's name and
 * the branch it is on. Filing it would put both on the volume and, through
 * triage, into a model turn. So the owner is checked before anything is filed:
 * blocked means never an item, never triaged, never pushed, never shown.
 *
 * Owners are stored lowercased (see settings-store); GitHub logins are
 * case-insensitive, so the comparison has to be too.
 */
export function blockedOwner(fullName: string, owners: string[]): boolean {
  return owners.includes(fullName.split("/")[0].toLowerCase());
}

export function notificationItems(threads: Notification[], blocked: string[] = []): Seen[] {
  return threads
    .filter((n) => !blockedOwner(n.repository.full_name, blocked))
    .map((n) => ({
      id: `github:${n.id}`,
      source: "github",
      at: n.updated_at,
      title: `${n.repository.full_name}: ${n.subject.title}`,
      detail: `${n.subject.type}, ${REASON[n.reason] ?? n.reason}`,
      link: htmlUrl(n),
      version: n.updated_at,
    }));
}

/** New mail: one item per message, the envelope until triage reads it. */
export function mailItems(messages: MailSummary[]): Seen[] {
  return messages.map((m) => ({
    id: `mail:${m.uid}`,
    source: "mail",
    at: m.at,
    title: `${m.from}: ${m.subject}`,
    detail: m.address,
    link: null,
    version: String(m.uid),
  }));
}

/**
 * The calendar's only feed items: something with a place or a link starting
 * soon. The rest of the calendar is on Today already, and an item for every
 * event would be the calendar twice.
 */
export const SOON_MS = 30 * 60_000;

export function calendarItems(events: CalendarEvent[], now = Date.now()): Seen[] {
  return events
    .filter((e) => !e.allDay && (e.location || e.url))
    .filter((e) => {
      const start = Date.parse(e.start);
      return start > now && start - now <= SOON_MS;
    })
    .map((e) => ({
      id: `calendar:${e.uid}:${e.start}`,
      source: "calendar",
      at: e.start,
      title: `${e.summary} starts soon`,
      detail: [e.location, e.url].filter(Boolean).join(" "),
      link: e.url,
      version: e.start,
      urgency: "attention",
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
    return apply(notificationItems(threads, await readBlockedOwners()));
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

/**
 * Delete what a now-blocked owner left behind.
 *
 * The filter above only stops new items; anything filed before the owner was
 * blocked is still a row with the repository's name on it. Run when the list
 * is written and once at startup, which is every moment the list can change.
 * A notification item's title is `owner/repo: subject`, and nothing else in
 * the github source carries an owner, so a title with no slash is not ours.
 */
export async function purgeBlocked(): Promise<number> {
  const owners = await readBlockedOwners();
  if (!owners.length) return 0;
  let removed = 0;
  for (const item of await feed.list()) {
    if (item.source !== "github") continue;
    const repo = item.title.split(":")[0];
    if (!repo.includes("/") || !blockedOwner(repo, owners)) continue;
    await feed.remove(item.id);
    removed++;
  }
  return removed;
}

/** A source that is not set up is quiet, not broken; one that broke says so once. */
async function pollSource(
  name: "mail" | "calendar",
  configured: () => Promise<unknown>,
  read: () => Promise<Seen[]>,
  log: Logger,
): Promise<number> {
  if (!(await configured())) return 0;
  try {
    const n = await apply(await read());
    await feed.resolve(`${name}:poller`, "reading again");
    return n;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(err, `${name} unavailable`);
    await feed.upsert({
      id: `${name}:poller`,
      source: name,
      at: new Date().toISOString(),
      title: `${name === "mail" ? "Mail" : "The calendar"} could not be read`,
      detail: message.slice(0, 200),
      link: "/settings",
      version: message.slice(0, 200),
    });
    return 0;
  }
}

export const pollMail = (log: Logger) =>
  pollSource("mail", mail.mailConfig, async () => mailItems(await mail.recent()), log);

export const pollCalendar = (log: Logger) =>
  pollSource(
    "calendar",
    calendar.calendarConfig,
    async () => calendarItems(await calendar.today()),
    log,
  );

const GITHUB_EVERY_MS = 5 * 60_000;
const MAIL_EVERY_MS = 5 * 60_000;
const CALENDAR_EVERY_MS = 15 * 60_000;

/** The timers, for the sources that are not on this volume. */
export function startPollers(log: Logger): void {
  const every = (ms: number, name: string, fn: () => Promise<number>) => {
    const tick = async () => {
      try {
        const n = await fn();
        if (n) log.info(`feed: ${n} item(s) from ${name}`);
      } catch (err) {
        log.warn(err, `${name} poll failed`);
      }
    };
    void tick();
    setInterval(() => void tick(), ms).unref?.();
  };
  void purgeBlocked()
    .then((n) => n && log.info(`feed: ${n} item(s) removed from blocked owners`))
    .catch((err) => log.warn(err, "purge of blocked owners failed"));
  every(GITHUB_EVERY_MS, "github", async () => (await pollGithub(log)) + (await pollQueue(log)));
  every(MAIL_EVERY_MS, "mail", () => pollMail(log));
  every(CALENDAR_EVERY_MS, "calendar", () => pollCalendar(log));
}
