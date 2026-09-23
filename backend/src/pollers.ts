import type {
  CalendarEvent,
  FeedItem,
  MailSummary,
  MaintainerIssue,
  Memory,
  ScheduleRun,
  Session,
  SessionUsage,
} from "../../shared/api.js";
import * as calendar from "./calendar.js";
import * as mail from "./mail.js";
import { env } from "./env.js";
import * as feed from "./feed-store.js";
import type { Seen } from "./feed-store.js";
import { ghJson, ghNotifications, type Notification } from "./gh.js";
import * as loops from "./loops-store.js";
import { listQueue } from "./maintainer.js";
import { listProposals } from "./memory-store.js";
import { resolveInsideRepos } from "./paths.js";
import { listRuns, listSchedules } from "./schedules-store.js";
import { listSessions } from "./sessions-store.js";
import { readBlockedOwners } from "./settings-store.js";
import type { Logger } from "./logger.js";

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
        title: s.title,
        from: s.project,
        facts: [s.agent, s.id],
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

/**
 * What a run cost, in the one number a person reads. Cache reads are most of a
 * long session and are the cheap half, but leaving them out reports a fraction
 * of what was actually sent; they are counted, and the figure is rounded to a
 * thousand because nobody wants six digits on a feed row.
 */
function tokenCount(u: SessionUsage): string {
  const total = u.input + u.output + u.cacheRead + u.cacheWrite;
  return total >= 1000 ? `${Math.round(total / 1000)}k` : String(total);
}

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
      // What the run was and what it cost, which is the difference between a
      // sign-off worth reading and one of six that said nothing. The repo only
      // when there is one: an assistant run belongs to none.
      facts: [
        r.outcome,
        ...(r.project ? [r.project] : []),
        ...(r.usage ? [`${tokenCount(r.usage)} tokens`] : []),
      ],
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
    // The sentence itself is the title. "proposed" is who is asking, and it
    // was six characters of every row saying the same word.
    from: "proposed",
    title: p.text.length > 80 ? `${p.text.slice(0, 79)}…` : p.text,
    facts: p.source ? [`learned in ${p.source}`] : [],
    detail: "",
    link: "/runs",
    version: p.slug,
    urgency: "new",
  }));
}

/** The maintainer's queue: the repo's own issues, one item while each is open. */
export function queueItems(issues: MaintainerIssue[], blocked: string[] = []): Seen[] {
  // The issue's own url names its owner, so a blocked owner's queue is kept
  // out the way its notifications are: a checkout's directory name says nothing
  // about whose repo it is.
  return issues
    .filter((i) => !blockedOwner(pullOrIssue(i.url)?.repo ?? "", blocked))
    .map((i) => ({
      id: `github:queue:${i.project}#${i.number}`,
      source: "github",
      at: i.updatedAt,
      title: i.title,
      from: `${i.project}#${i.number}`,
      facts: [i.state, ...(i.tier ? [`tier:${i.tier}`] : []), "maintainer's queue"],
      detail: "",
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
  return owners.includes((fullName.split("/")[0] ?? "").toLowerCase());
}

export function notificationItems(threads: Notification[], blocked: string[] = []): Seen[] {
  return threads
    .filter((n) => !blockedOwner(n.repository.full_name, blocked))
    .map((n) => ({
      id: `github:${n.id}`,
      source: "github",
      at: n.updated_at,
      title: n.subject.title,
      // The repo, not the owner and the repo: six rows of "mortennordbye/" is
      // six times the same word in the column the eye reads down.
      from: n.repository.full_name.split("/").pop() ?? n.repository.full_name,
      facts: [n.subject.type, REASON[n.reason] ?? n.reason],
      // Empty, not the same words the facts line already carries — the row
      // draws both, and it read "PullRequest, on something you watch" twice.
      // Triage writes what this one is actually about.
      detail: "",
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
    // Sender and subject apart, not "Google: Security alert" in one string:
    // the row draws them differently, and the address is the half that says
    // whether a security alert is really Google's.
    title: m.subject,
    from: m.from,
    facts: [m.address, ...(m.unread ? ["unread"] : [])],
    // Not the address: that is a fact now, and a row drawing it as the detail
    // line too said the same thing twice. Left empty until triage writes what
    // the mail is about, which is what a detail line is for.
    detail: "",
    link: null,
    version: String(m.uid),
  }));
}

/**
 * A message that left the inbox is off the feed.
 *
 * Filing is the point of the move, and a spam row that stays on Today after
 * the message was filed is the move half done. `recent` reads a window of the
 * newest thirty, so absence only means something inside that window: anything
 * older than the oldest message read is left alone, because "not in the last
 * thirty" is not "gone". The poller's own error item is not a message and is
 * matched out by the id shape.
 */
export function filedAway(seen: Seen[], items: FeedItem[]): string[] {
  if (!seen.length) return [];
  const here = new Set(seen.map((s) => s.id));
  const oldest = seen.map((s) => s.at).reduce((a, at) => (at < a ? at : a));
  return items
    .filter((i) => /^mail:\d+$/.test(i.id) && i.state !== "done")
    .filter((i) => i.at >= oldest && !here.has(i.id))
    .map((i) => i.id);
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

/**
 * File what a source says now, and end what it no longer says.
 *
 * `repeats` is for the sources whose version is a constant rather than an
 * event number — see feed.refile. Off by default: for everything else an equal
 * version is the same event, and that is what keeps a read mail read.
 */
async function apply(
  seen: Seen[],
  over: string[] = [],
  why = "over",
  repeats = false,
): Promise<number> {
  let changed = 0;
  const file = repeats ? feed.refile : feed.upsert;
  for (const s of seen) if ((await file(s)).changed) changed++;
  for (const id of over) await feed.resolve(id, why);
  return changed;
}

/**
 * A run that a later run of the same schedule has replaced.
 *
 * Every firing files an item, and the newest one is the schedule's current
 * word. Loud ones included, which they used to be spared: a problem still there
 * is reported again by the next run, and one that was fixed kept a week of rows
 * saying it was broken. Twenty of those were most of a "needs you" of 37, each
 * morning briefing repeating the last. Newest across done items too, so a
 * person finishing the latest row does not hand "newest" back to an older one.
 */
async function supersededRuns(): Promise<string[]> {
  const newest = new Map<string, string>();
  const items = (await feed.list()).filter((i) => i.source === "schedule");
  for (const i of items) {
    // `schedule:<id>:<at>`, and the schedule id has no colons.
    const id = i.id.split(":")[1];
    // An id without the schedule in it is not one of these to compare.
    if (id === undefined) continue;
    if (!newest.has(id) || i.at > (newest.get(id) as string)) newest.set(id, i.at);
  }
  return items
    .filter((i) => {
      const id = i.id.split(":")[1];
      return id !== undefined && i.state !== "done" && i.at !== newest.get(id);
    })
    .map((i) => i.id);
}

/**
 * The same GitHub notification, sent again.
 *
 * A workflow failing twice on one branch is two notifications with one subject
 * and one link, and the second says nothing the first did not. The newest
 * stays; the rest are over. The poller's own error row and the maintainer's
 * queue are not notifications.
 */
export function repeatedFailures(items: FeedItem[]): string[] {
  const open = items.filter(
    (i) =>
      i.source === "github" &&
      i.state !== "done" &&
      i.id !== "github:poller" &&
      !i.id.startsWith("github:queue:"),
  );
  const key = (i: FeedItem) => `${i.title}\n${i.link ?? ""}`;
  const newest = new Map<string, FeedItem>();
  for (const i of open) {
    const kept = newest.get(key(i));
    if (!kept || i.at > kept.at) newest.set(key(i), i);
  }
  return open.filter((i) => newest.get(key(i)) !== i).map((i) => i.id);
}

/** How long a mail keeps shouting when nothing it belongs to is open. */
export const MAIL_URGENT_DAYS = 3;

/**
 * Mail that has been urgent for days without anything coming of it.
 *
 * A security alert or a confirm-your-address is urgent the morning it lands
 * and noise by the weekend, and nothing else ever took one off "needs you".
 * It fades rather than ends: still in the inbox as new, so an exam reminder or
 * a password warning is there to find, just not shouting. One triage tied to a
 * loop keeps shouting, since the loop says something is still open about it.
 */
export function fadedMail(items: FeedItem[], now = Date.now()): string[] {
  return items
    .filter(
      (i) =>
        i.source === "mail" &&
        i.state !== "done" &&
        i.urgency === "attention" &&
        !i.loop &&
        now - Date.parse(i.at) >= MAIL_URGENT_DAYS * 86_400_000,
    )
    .map((i) => i.id);
}

/**
 * The bench's own lists, filed. Run by the sweeper on its five-second tick,
 * not by the GET that reads the feed (R-33): what the volume does no longer
 * depends on who has the inbox open, and the inbox is at most a tick behind.
 */
export function pollBench(): Promise<number> {
  // One pass at a time, shared. Three tabs and a phone each open the inbox, and
  // each open ran the whole of this on top of the others: the same items filed
  // and resolved four times over, interleaved.
  benchPass ??= fileBench().finally(() => {
    benchPass = null;
  });
  return benchPass;
}

let benchPass: Promise<number> | null = null;

async function fileBench(): Promise<number> {
  const [sessions, runs, proposals] = await Promise.all([
    listSessions(),
    listRuns(),
    listProposals(),
  ]);
  const { seen, over } = sessionItems(sessions);
  // A session that stops to ask a second time is a second event, although
  // `waiting` is all its version ever says.
  let changed = await apply(seen, over, "answered", true);
  // A deleted session is not in the list at all, so sessionItems never sees it
  // end, and its row stayed on "needs you" for a session that was gone.
  const known = new Set(sessions.map((s) => `bench:wait:${s.id}`));
  for (const i of await feed.list()) {
    if (i.id.startsWith("bench:wait:") && i.state !== "done" && !known.has(i.id)) {
      await feed.resolve(i.id, "session gone");
    }
  }
  changed += await apply(runItems(runs));
  // After filing, not before: the run that supersedes the others is the one
  // this pass has just put on the feed.
  for (const id of await supersededRuns()) await feed.resolve(id, "a later run");
  // A proposal that is gone was kept or dropped; either way it is over.
  const open = new Set(proposals.map((p) => `memory:${p.slug}`));
  const gone = (await feed.list())
    .filter((i) => i.source === "memory" && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  changed += await apply(proposalItems(proposals), gone, "reviewed");
  // Every source's items live on this volume, so tidying them costs a read and
  // belongs here, on the sweeper's tick, not behind a remote poller's timer.
  const items = await feed.list();
  for (const id of repeatedFailures(items)) await feed.resolve(id, "sent again");
  for (const id of fadedMail(items)) {
    await feed.fade(id, `no longer urgent after ${MAIL_URGENT_DAYS} days`);
  }
  await closeSettledLoops();
  await feed.liftSnoozes();
  return changed;
}

/**
 * A loop whose source item is done is done.
 *
 * A loop outlives the item it came from, which is why it is a separate thing —
 * but not past the point where the person has finished with that item. Only
 * the loops opened from one: `from` is the feed id for those, and a word like
 * "you" or a document's path for the rest, which end when someone says so.
 * Nothing here reopens a loop, so an item that comes back does not revive a
 * loop that was closed on purpose.
 */
async function closeSettledLoops(): Promise<void> {
  const open = (await loops.list()).filter((l) => l.from !== null);
  if (!open.length) return;
  const done = new Set((await feed.list()).filter((i) => i.state === "done").map((i) => i.id));
  for (const l of open) if (done.has(l.from as string)) await loops.close(l.slug);
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
  const items = queueItems(issues, await readBlockedOwners());
  const open = new Set(items.map((i) => i.id));
  const gone = (await feed.list())
    .filter((i) => i.id.startsWith("github:queue:") && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  return apply(items, gone, "off the queue");
}

/** How long an unread notification is still news. */
const GITHUB_STALE_MS = 7 * 24 * 60 * 60_000;

/** The repo and number a feed item's link points at, when it points at one. */
function pullOrIssue(link: string | null): { repo: string; number: number } | null {
  // Owner and repo as GitHub itself spells them: the link is built from the
  // API's own url, and the pair goes into a request path.
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/(?:pull|issues)\/(\d+)/.exec(
    link ?? "",
  );
  return m?.[1] ? { repo: m[1], number: Number(m[2]) } : null;
}

/**
 * End the github items that are over.
 *
 * GitHub's notifications endpoint answers with what is unread, so — unlike
 * every other source here — absent from the response cannot mean over: on the
 * first poll it would resolve everything already read, which is right for a
 * notification and wrong for the review it stands for. So the item is asked
 * about instead. A pull request or an issue that is closed upstream is done,
 * whatever its age, and the loop it opened closes with it (closeSettledLoops).
 * Anything still unread after a week is done too: a notification from last
 * week is not news, and this is the half that keeps the feed from growing
 * without bound whatever the item points at.
 *
 * One call per repository, not per item — the repo's open issues list carries
 * its pull requests too. A repository with a full page of them is left alone:
 * past a hundred, "not on the list" stops meaning closed.
 */
async function endSettledGithub(log: Logger, now = Date.now()): Promise<void> {
  const open = (await feed.list()).filter(
    (i) => i.source === "github" && i.state !== "done" && !i.id.startsWith("github:queue:"),
  );
  const byRepo = new Map<string, { id: string; number: number }[]>();
  for (const i of open) {
    if (now - Date.parse(i.at) > GITHUB_STALE_MS) {
      await feed.resolve(i.id, "a week unread");
      continue;
    }
    const at = pullOrIssue(i.link);
    if (!at) continue;
    const list = byRepo.get(at.repo) ?? [];
    list.push({ id: i.id, number: at.number });
    byRepo.set(at.repo, list);
  }
  for (const [repo, items] of byRepo) {
    let listed: { number: number }[];
    try {
      listed = await ghJson<{ number: number }[]>(env.REPOS_DIR, [
        "api",
        `repos/${repo}/issues?state=open&per_page=100`,
      ]);
    } catch (err) {
      // One unreadable repo leaves its items where they are.
      log.warn(err, `open issues for ${repo} unavailable`);
      continue;
    }
    if (listed.length >= 100) continue;
    const stillOpen = new Set(listed.map((n) => n.number));
    for (const i of items) {
      if (!stillOpen.has(i.number)) await feed.resolve(i.id, "closed on GitHub");
    }
  }
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
    const changed = await apply(notificationItems(threads, await readBlockedOwners()));
    await endSettledGithub(log);
    return changed;
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
 * A notification item's title is `owner/repo: subject`; a maintainer's queue
 * item carries its owner only in its link, so both are read.
 */
export async function purgeBlocked(): Promise<number> {
  const owners = await readBlockedOwners();
  if (!owners.length) return 0;
  let removed = 0;
  for (const item of await feed.list()) {
    if (item.source !== "github") continue;
    const titled = item.title.split(":")[0] ?? "";
    const repo = titled.includes("/") ? titled : (pullOrIssue(item.link)?.repo ?? "");
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
  read: () => Promise<{ seen: Seen[]; over?: string[] }>,
  log: Logger,
): Promise<number> {
  if (!(await configured())) return 0;
  try {
    const { seen, over } = await read();
    const n = await apply(seen, over, "filed");
    await feed.resolve(`${name}:poller`, "reading again");
    return n;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(err, `${name} unavailable`);
    // Refiled, not upserted: the same failure after a spell of working is the
    // source breaking again, and its version is the message either way.
    await feed.refile({
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
  pollSource(
    "mail",
    mail.mailConfig,
    async () => {
      const seen = mailItems(await mail.recent());
      return { seen, over: filedAway(seen, await feed.list()) };
    },
    log,
  );

export const pollCalendar = (log: Logger) =>
  pollSource(
    "calendar",
    calendar.calendarConfig,
    async () => ({ seen: calendarItems(await calendar.today()) }),
    log,
  );

const GITHUB_EVERY_MS = 5 * 60_000;
const MAIL_EVERY_MS = 5 * 60_000;
const CALENDAR_EVERY_MS = 15 * 60_000;

/** The timers, for the sources that are not on this volume. */
export function startPollers(log: Logger): void {
  const every = (ms: number, name: string, fn: () => Promise<number>) => {
    // A source that is slow or hung must not have a second pass started on top
    // of it: two passes over the same inbox file the same items twice.
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        const n = await fn();
        if (n) log.info(`feed: ${n} item(s) from ${name}`);
      } catch (err) {
        log.warn(err, `${name} poll failed`);
      } finally {
        running = false;
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
