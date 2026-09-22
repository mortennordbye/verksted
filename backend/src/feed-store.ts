import fs from "node:fs/promises";
import path from "node:path";
import type {
  FeedItem,
  FeedSource,
  FeedState,
  FeedUrgency,
  ProposalAction,
} from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";
import * as loops from "./loops-store.js";

/**
 * The feed: things that happened, one JSON file per item.
 *
 * A poller files an item under the source's own id, so an event becomes one
 * item once and a restart re-reading the source finds it already there. What
 * a poller may not do is judge: the item arrives `new`, untriaged, with the
 * poller's raw title, and the triage turn is what decides whether it is
 * attention, what one line says about it, and whether it belongs to a loop.
 *
 * State is the person's. `done` and `snoozed` are set from the screen; the
 * assistant reads state and never sets it, except to append what it did.
 */
export const DONE_KEPT_DAYS = 30;

function dir(): string {
  return env.FEED_DIR;
}

/** Ids are the source's own text; the file name is a safe rendering of it. */
function fileOf(id: string): string {
  return path.join(dir(), `${id.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 150)}.json`);
}

/**
 * The last parse of each item, by file name, good for as long as the file's
 * size and mtime say it has not moved.
 *
 * One open of the inbox lists the feed six times, because each step of
 * `pollBench` changes it and the next has to see the change, and every one of
 * those read and parsed every item on the volume (R-20). Most of a feed is
 * items nobody has touched since they were filed. Tested against the file and
 * not a clock, so a write from anywhere (this process, `vk restore`) is seen.
 * What is handed out is a copy: callers change the items they are given.
 *
 * The inode is part of the test. Every write here is a rename of a new file,
 * so it always moves, where "seen" becoming "done" inside one tick of a coarse
 * mtime changes neither of the other two.
 */
const parsed = new Map<string, { ino: number; size: number; mtimeMs: number; item: FeedItem }>();

/** Forget every cached read. For tests, which rewrite these files in place. */
export function resetFeedCache(): void {
  parsed.clear();
}

async function readFileCached(file: string): Promise<FeedItem> {
  const { ino, size, mtimeMs } = await fs.stat(file);
  const hit = parsed.get(file);
  if (hit && hit.ino === ino && hit.size === size && hit.mtimeMs === mtimeMs) {
    return structuredClone(hit.item);
  }
  const item = stored(await fs.readFile(file, "utf8"));
  parsed.set(file, { ino, size, mtimeMs, item });
  return structuredClone(item);
}

async function readAll(): Promise<FeedItem[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir());
  } catch {
    return [];
  }
  const out: FeedItem[] = [];
  const present = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir(), name);
    present.add(file);
    try {
      out.push(await readFileCached(file));
    } catch {
      // One unreadable item loses one item, not the feed.
      parsed.delete(file);
    }
  }
  // What the sweep deleted should not be held for ever.
  for (const file of parsed.keys()) if (!present.has(file)) parsed.delete(file);
  return out;
}

/**
 * An item as stored, with the fields it may predate filled in.
 *
 * Every read goes through this. Doing it in one of the two readers and not the
 * other is what made the backfill in `upsert` dead code: it reads through
 * `get`, which handed back an item whose `from` was `undefined` rather than
 * null, so the guard looking for null never matched and no item ever gained a
 * sender by that path.
 */
function stored(json: string): FeedItem {
  const item = JSON.parse(json) as FeedItem;
  item.from ??= null;
  item.facts ??= [];
  return item;
}

export async function get(id: string): Promise<FeedItem | null> {
  try {
    return await readFileCached(fileOf(id));
  } catch {
    return null;
  }
}

async function write(item: FeedItem): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await writeJsonAtomic(fileOf(item.id), item);
}

/** What a poller knows about an event. Everything else is the store's. */
export interface Seen {
  id: string;
  source: FeedSource;
  at: string;
  title: string;
  /** Who it is from, where the source has one. See FeedItem.from. */
  from?: string;
  /** The facts that decide it, worded here. See FeedItem.facts. */
  facts?: string[];
  detail: string;
  link: string | null;
  version: string;
  /** Rare: a rule that must not wait for triage (a red build on main). */
  urgency?: FeedUrgency;
  /** A proposal's action. Judged already: the assistant wrote it. */
  action?: ProposalAction;
}

/** A proposal nobody tapped is dropped after this long, and says so. */
export const PROPOSAL_DAYS = 3;

/**
 * File an event, or update the item it already is.
 *
 * The version is the whole of the decision: the same version is the same
 * event and nothing changes, including the state the person put it in; a new
 * version is the event moving on, and the item comes back as new and unjudged
 * whatever it was. An item you finished with does not stay finished when the
 * thread it tracks gets a reply.
 */
export async function upsert(seen: Seen): Promise<{ item: FeedItem; changed: boolean }> {
  const existing = await get(seen.id);
  if (existing && existing.version === seen.version) {
    // The same event, so the person's state is left exactly as it is. The one
    // thing taken from it: a sender and its facts, for an item filed before
    // the poller knew to keep them apart. A mail's version is its uid and
    // never changes, so without this the items already on the volume would
    // have drawn a row with no sender for as long as they lived — and the
    // crude fix, a new version scheme, would mark every one of them unread
    // again and undo the snoozes.
    if (existing.from === null && seen.from !== undefined) {
      existing.from = seen.from;
      existing.facts = seen.facts ?? [];
      // The title goes with them: the old one has the sender concatenated into
      // it, so keeping it would draw "Google · Google: Security alert". Safe to
      // take because the poller is the only thing that ever writes a title.
      existing.title = seen.title;
      await write(existing);
    }
    return { item: existing, changed: false };
  }
  const item: FeedItem = {
    id: seen.id,
    source: seen.source,
    at: existing?.at ?? seen.at,
    title: seen.title,
    from: seen.from ?? null,
    facts: seen.facts ?? [],
    detail: seen.detail,
    urgency: seen.urgency ?? "new",
    state: "new",
    until: null,
    link: seen.link,
    loop: existing?.loop ?? null,
    did: existing?.did ?? null,
    triaged: seen.action !== undefined,
    version: seen.version,
    pushed: false,
    ...(seen.action ? { action: seen.action } : {}),
  };
  await write(item);
  return { item, changed: true };
}

/**
 * File something whose version does not move when it happens again (R-19).
 *
 * The rule above is the right one for a source that numbers its events: a mail
 * keeps its uid for ever, so an equal version has to mean "the same mail, leave
 * it as the person left it". Two sources here have no such number — a session
 * waiting for an answer is filed as `waiting`, a poller that cannot reach its
 * source as the error it got — and for those an equal version meant the second
 * time never came back: the item was `done` from the first time and stayed
 * there. A session that stopped to ask twice was invisible the second time.
 *
 * The version moves when, and only when, the item had been finished with, so
 * nothing churns while the same thing is still going on.
 */
export async function refile(seen: Seen): Promise<{ item: FeedItem; changed: boolean }> {
  const existing = await get(seen.id);
  if (existing?.state === "done" && existing.version === seen.version) {
    return upsert({ ...seen, version: `${seen.version}#${Date.now()}` });
  }
  return upsert(seen);
}

function snoozeOver(item: FeedItem, now: string): boolean {
  return item.state === "snoozed" && item.until !== null && item.until <= now;
}

/**
 * The feed as the screen reads it: newest first, a snooze that is over shown
 * as new. Only shown: the write is `liftSnoozes`, on the background pass, so a
 * read never writes (R-33).
 */
export async function list(): Promise<FeedItem[]> {
  const now = new Date().toISOString();
  const items = await readAll();
  for (const item of items) {
    if (snoozeOver(item, now)) {
      item.state = "new";
      item.until = null;
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** Write down the snoozes that are over, which `list` has been showing as new. */
export async function liftSnoozes(): Promise<void> {
  const now = new Date().toISOString();
  for (const item of await readAll()) {
    if (!snoozeOver(item, now)) continue;
    item.state = "new";
    item.until = null;
    await write(item);
  }
}

export async function untriaged(): Promise<FeedItem[]> {
  return (await list()).filter((i) => !i.triaged && i.state !== "done");
}

export async function setState(
  id: string,
  state: FeedState,
  until: string | null = null,
): Promise<FeedItem | null> {
  const item = await get(id);
  if (!item) return null;
  item.state = state;
  item.until = state === "snoozed" ? until : null;
  await write(item);
  return item;
}

/**
 * Triage's verdict on an item, as it was when triage read it.
 *
 * A turn takes a minute or more, and a poller can file a newer version of the
 * same item meanwhile: a pull request that was "review requested" when it was
 * judged and "changes requested by you" by the time the verdict lands. Marking
 * that one triaged with the old verdict is how it would never be judged at all.
 * A verdict for a version that has moved on is dropped, and the item is judged
 * on the next pass.
 */
export async function judge(
  id: string,
  verdict: { urgency: FeedUrgency; detail?: string; loop?: string | null; version?: string },
): Promise<FeedItem | null> {
  const item = await get(id);
  if (!item) return null;
  if (verdict.version !== undefined && item.version !== verdict.version) return null;
  item.urgency = verdict.urgency;
  if (verdict.detail?.trim()) item.detail = verdict.detail.trim();
  if (verdict.loop !== undefined) item.loop = verdict.loop;
  item.triaged = true;
  await write(item);
  return item;
}

export async function markPushed(id: string): Promise<void> {
  const item = await get(id);
  if (!item || item.pushed) return;
  item.pushed = true;
  await write(item);
}

/** What the assistant did about it, appended to the row. */
export async function did(id: string, what: string): Promise<FeedItem | null> {
  const item = await get(id);
  if (!item) return null;
  item.did = item.did ? `${item.did}; ${what}` : what;
  await write(item);
  return item;
}

/**
 * A poller saying an event is over: the session answered, the proposal kept,
 * the issue closed. Done rather than deleted, so the row says what happened.
 */
export async function resolve(id: string, what: string): Promise<void> {
  const item = await get(id);
  if (!item || item.state === "done") return;
  item.state = "done";
  item.did = item.did ? `${item.did}; ${what}` : what;
  await write(item);
}

/**
 * Still here, no longer shouting: attention becomes new, and the row says why.
 *
 * For what time alone has settled. Resolving would claim something happened
 * to it, and the person may still want to find it in the inbox.
 */
export async function fade(id: string, why: string): Promise<void> {
  const item = await get(id);
  if (!item || item.state === "done" || item.urgency !== "attention") return;
  item.urgency = "new";
  item.did = item.did ? `${item.did}; ${why}` : why;
  await write(item);
}

/**
 * Delete an item outright, leaving no row and no title behind.
 *
 * The one thing resolve() cannot do: a blocked owner's item must not survive
 * as a done row, because the row is the repository name and the name is the
 * thing that should not be here (see pollers.purgeBlocked).
 */
export async function remove(id: string): Promise<void> {
  await fs.rm(fileOf(id), { force: true });
}

/** An item nothing has touched in this long is over, whatever state it was left in (R-20). */
export const QUIET_DAYS = 30;

/**
 * Whether an untouched item may be aged out. Not the bench's rows or a
 * poller's own error row: those are filed again for as long as they are true,
 * and one aged out while still true would come back as new and push again.
 * Not a snooze, which the person set an end to, and not an item a loop hangs
 * still open on, since that loop closes when its item is done.
 */
function mayAge(item: FeedItem, looped: Set<string>): boolean {
  return (
    item.state !== "done" &&
    item.state !== "snoozed" &&
    item.source !== "bench" &&
    !item.id.endsWith(":poller") &&
    item.loop === null &&
    !looped.has(item.id)
  );
}

/**
 * Done items go after thirty days; nothing else is ever deleted here. A
 * proposal nobody tapped expires first, as a done item that says so, and any
 * other item nothing has written to for `QUIET_DAYS` is resolved the same way
 * and goes with the done ones on a later pass. Untouched means the file: a
 * triage, a state change or a new version all rewrite it.
 */
export async function sweep(now = Date.now()): Promise<number> {
  let removed = 0;
  const looped = new Set((await loops.list()).flatMap((l) => (l.from ? [l.from] : [])));
  for (const item of await readAll()) {
    if (
      item.source === "proposal" &&
      item.state !== "done" &&
      now - Date.parse(item.at) >= PROPOSAL_DAYS * 86_400_000
    ) {
      await resolve(item.id, "expired untapped");
      continue;
    }
    if (mayAge(item, looped)) {
      const stat = await fs.stat(fileOf(item.id)).catch(() => null);
      if (stat && now - stat.mtimeMs >= QUIET_DAYS * 86_400_000) {
        await resolve(item.id, `quiet for ${QUIET_DAYS} days`);
      }
      continue;
    }
    if (item.state !== "done") continue;
    if (now - Date.parse(item.at) < DONE_KEPT_DAYS * 86_400_000) continue;
    await fs.rm(fileOf(item.id), { force: true });
    removed++;
  }
  return removed;
}
