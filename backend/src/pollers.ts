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
export function queueItems(issues: MaintainerIssue[]): Seen[] {
  return issues.map((i) => ({
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
  return owners.includes(fullName.split("/")[0].toLowerCase());
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
  const oldest = seen.reduce((a, s) => (s.at < a ? s.at : a), seen[0].at);
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

/** File what a source says now, and end what it no longer says. */
async function apply(seen: Seen[], over: string[] = [], why = "over"): Promise<number> {
  let changed = 0;
  for (const s of seen) if ((await feed.upsert(s)).changed) changed++;
  for (const id of over) await feed.resolve(id, why);
  return changed;
}

/**
 * A routine run that a later run has replaced.
 *
 * Every firing files an item, and a quiet one is a routine ok: worth a row on
 * the morning it happened, and history the moment the schedule fires again.
 * Nothing used to end them, so nine days of nightly renders and tidy-ups sat
 * in the inbox as new, and the six the screen shows were the six least worth
 * reading. Only the quiet ones: a run that needed someone keeps its row until
 * someone deals with it, however many have run since.
 */
async function supersededRuns(): Promise<string[]> {
  const newest = new Map<string, string>();
  const items = (await feed.list()).filter((i) => i.source === "schedule" && i.state !== "done");
  for (const i of items) {
    // `schedule:<id>:<at>`, and the schedule id has no colons.
    const id = i.id.split(":")[1];
    if (!newest.has(id) || i.at > (newest.get(id) as string)) newest.set(id, i.at);
  }
  return items
    .filter((i) => i.urgency === "quiet" && i.at !== newest.get(i.id.split(":")[1]))
    .map((i) => i.id);
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
  // After filing, not before: the run that supersedes the others is the one
  // this pass has just put on the feed.
  for (const id of await supersededRuns()) await feed.resolve(id, "a later run");
  // A proposal that is gone was kept or dropped; either way it is over.
  const open = new Set(proposals.map((p) => `memory:${p.slug}`));
  const gone = (await feed.list())
    .filter((i) => i.source === "memory" && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  changed += await apply(proposalItems(proposals), gone, "reviewed");
  await closeSettledLoops();
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
  const open = new Set(queueItems(issues).map((i) => i.id));
  const gone = (await feed.list())
    .filter((i) => i.id.startsWith("github:queue:") && i.state !== "done" && !open.has(i.id))
    .map((i) => i.id);
  return apply(queueItems(issues), gone, "off the queue");
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
  return m ? { repo: m[1], number: Number(m[2]) } : null;
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
