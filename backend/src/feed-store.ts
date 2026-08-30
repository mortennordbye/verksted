import fs from "node:fs/promises";
import path from "node:path";
import type { FeedItem, FeedSource, FeedState, FeedUrgency } from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";

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

async function readAll(): Promise<FeedItem[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir());
  } catch {
    return [];
  }
  const out: FeedItem[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir(), name), "utf8")) as FeedItem);
    } catch {
      // One unreadable item loses one item, not the feed.
    }
  }
  return out;
}

export async function get(id: string): Promise<FeedItem | null> {
  try {
    return JSON.parse(await fs.readFile(fileOf(id), "utf8")) as FeedItem;
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
  detail: string;
  link: string | null;
  version: string;
  /** Rare: a rule that must not wait for triage (a red build on main). */
  urgency?: FeedUrgency;
}

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
  if (existing && existing.version === seen.version) return { item: existing, changed: false };
  const item: FeedItem = {
    id: seen.id,
    source: seen.source,
    at: existing?.at ?? seen.at,
    title: seen.title,
    detail: seen.detail,
    urgency: seen.urgency ?? "new",
    state: "new",
    until: null,
    link: seen.link,
    loop: existing?.loop ?? null,
    did: existing?.did ?? null,
    triaged: false,
    version: seen.version,
    pushed: false,
  };
  await write(item);
  return { item, changed: true };
}

/** The feed as the screen reads it: newest first, snoozes that are over lifted. */
export async function list(): Promise<FeedItem[]> {
  const now = new Date().toISOString();
  const items = await readAll();
  for (const item of items) {
    if (item.state === "snoozed" && item.until && item.until <= now) {
      item.state = "new";
      item.until = null;
      await write(item);
    }
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
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

/** Triage's verdict on an item. */
export async function judge(
  id: string,
  verdict: { urgency: FeedUrgency; detail?: string; loop?: string | null },
): Promise<FeedItem | null> {
  const item = await get(id);
  if (!item) return null;
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

/** Done items go after thirty days; nothing else is ever deleted here. */
export async function sweep(now = Date.now()): Promise<number> {
  let removed = 0;
  for (const item of await readAll()) {
    if (item.state !== "done") continue;
    if (now - Date.parse(item.at) < DONE_KEPT_DAYS * 86_400_000) continue;
    await fs.rm(fileOf(item.id), { force: true });
    removed++;
  }
  return removed;
}
