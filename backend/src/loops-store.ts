import fs from "node:fs/promises";
import path from "node:path";
import type { Loop } from "../../shared/api.js";
import { writeJsonAtomic } from "./atomic-json.js";
import { env } from "./env.js";

/**
 * Open loops: the list you would otherwise keep in your head.
 *
 * What you owe and what you are owed, where it came from, and when it is due.
 * Opened by triage from what it reads, by the assistant when you say "remind
 * me", and closed when something shows it is done or when you say so. A loop
 * is separate from a fact because a fact stays true and a loop is meant to
 * end; it is separate from a feed item because an item is one event and a loop
 * outlives several.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function dir(): string {
  return env.LOOPS_DIR;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function readAll(): Promise<Loop[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir());
  } catch {
    return [];
  }
  const out: Loop[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir(), name), "utf8")) as Loop);
    } catch {
      // One unreadable loop loses one loop.
    }
  }
  return out;
}

export async function get(slug: string): Promise<Loop | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dir(), `${slug}.json`), "utf8")) as Loop;
  } catch {
    return null;
  }
}

async function write(loop: Loop): Promise<void> {
  await fs.mkdir(dir(), { recursive: true });
  await writeJsonAtomic(path.join(dir(), `${loop.slug}.json`), loop);
}

/** Due first, the undated after, oldest first within each. */
function order(a: Loop, b: Loop): number {
  if (a.due && b.due && a.due !== b.due) return a.due.localeCompare(b.due);
  if (a.due && !b.due) return -1;
  if (!a.due && b.due) return 1;
  return a.openedAt.localeCompare(b.openedAt);
}

export async function list(state: Loop["state"] | "all" = "open"): Promise<Loop[]> {
  return (await readAll()).filter((l) => state === "all" || l.state === state).sort(order);
}

const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Open one. The slug comes from the words, with a number when the words are
 * already taken; a loop reopened with the same words is a new loop, since the
 * old one ended for a reason.
 */
export async function open(input: {
  what: string;
  who?: string | null;
  from?: string | null;
  due?: string | null;
}): Promise<Loop> {
  const what = input.what.replace(/\s*\n\s*/g, " ").trim();
  if (!what) throw new Error("a loop needs words");
  if (input.due && !DUE_RE.test(input.due)) throw new Error("due must be YYYY-MM-DD");
  const base = slugify(what) || "loop";
  let slug = base;
  for (let n = 2; await get(slug); n++) slug = `${base}-${n}`;
  const loop: Loop = {
    slug,
    what,
    who: input.who?.trim() || null,
    from: input.from?.trim() || null,
    due: input.due || null,
    state: "open",
    openedAt: new Date().toISOString(),
    closedAt: null,
  };
  await write(loop);
  return loop;
}

export async function close(slug: string): Promise<Loop | null> {
  const loop = await get(slug);
  if (!loop) return null;
  if (loop.state === "open") {
    loop.state = "closed";
    loop.closedAt = new Date().toISOString();
    await write(loop);
  }
  return loop;
}

export async function remove(slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;
  try {
    await fs.rm(path.join(dir(), `${slug}.json`));
    return true;
  } catch {
    return false;
  }
}

/** The open loops as a prompt reads them: one line each, due first. */
export function render(loops: Loop[]): string {
  return loops
    .map(
      (l) => `- ${l.slug}: ${l.what}${l.who ? ` (${l.who})` : ""}${l.due ? `, due ${l.due}` : ""}`,
    )
    .join("\n");
}
