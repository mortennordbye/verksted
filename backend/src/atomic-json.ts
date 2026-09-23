import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Write a JSON record so a concurrent reader never sees it half-written.
 *
 * Every store here is read by a poller while something else writes it: three
 * clients poll the session list, and the scheduler stamps a schedule's last
 * firing while the UI is reading that same schedule back. A plain writeFile
 * truncates the target before writing, so a reader landing in that window gets
 * invalid JSON — and both stores turn a parse failure into "no such record"
 * rather than an error, which is how a session disappeared from history for
 * good and how a schedule read back as null a moment after it existed.
 *
 * rename(2) is atomic within a filesystem, so a reader sees either the whole
 * old file or the whole new one.
 *
 * The temp name must not end in ".json": the directory scans that back these
 * stores would pick it up and try to parse it.
 */
export async function writeJsonAtomic(
  target: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await writeAtomic(target, JSON.stringify(value, null, 2), mode);
}

/**
 * The same, for a file that is not JSON.
 *
 * The assistant's `current` is one line holding a conversation id, and it is
 * read by every poll while a turn is writing it. Truncated, it reads as no
 * conversation at all — which is worse than unparseable JSON, because the
 * reader's answer to that is to start a new one.
 */
export async function writeTextAtomic(target: string, text: string): Promise<void> {
  await writeAtomic(target, text);
}

async function writeAtomic(target: string, body: string, mode?: number): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    // The mode goes on the temp file: rename carries it over, and setting it
    // afterwards would leave the secret readable for the window in between.
    const handle = await fs.open(tmp, "w", mode);
    try {
      await handle.writeFile(body);
      // Before the rename, or the rename can reach the disk first: on the NFS
      // volume a node that dies in between leaves the *target* zero bytes
      // long, and every store here reads that as "no such record".
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
    await syncDir(path.dirname(target));
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

/**
 * The rename itself is a change to the directory. Best effort: not every
 * filesystem lets a directory be opened for it, and the file's own sync is the
 * half that keeps a record from reading back empty.
 */
async function syncDir(dir: string): Promise<void> {
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // See above.
  }
}

/** Leftover temp files from a pod killed mid-write; called once at boot. */
export async function sweepTempFiles(dir: string): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    for (const f of files.filter((f) => f.endsWith(".tmp"))) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  } catch {
    // Nothing to sweep, or the dir is unreadable — boot regardless.
  }
}

/**
 * The ids of the `<id>.json` records in a store's directory, and none while
 * the directory does not exist yet. `valid` is the store's own id rule: a
 * directory on the volume can hold anything, and a name that is not an id is
 * not one of its records.
 *
 * With `readJsonDir` below, the one way the stores list what they hold (R-34);
 * each used to hand-roll the readdir, the suffix check and the skip.
 */
export async function jsonIds(dir: string, valid: RegExp = /./): Promise<string[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  return names
    .filter((n) => n.endsWith(".json"))
    .map((n) => n.slice(0, -5))
    .filter((id) => valid.test(id));
}

/**
 * Whether a parsed record is an object carrying each of `fields` as a string.
 *
 * What a store's list sorts and keys on (R-31): a file holding `{}` or `null`
 * parses fine, and then throws out of the sort and takes every record with it.
 */
export function hasStrings(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return fields.every((f) => typeof record[f] === "string");
}

/**
 * Every record in a store's directory, parsed. One that will not read or parse,
 * or lacks one of `fields` as a string, is skipped: one torn file loses one
 * record, not the list.
 */
export async function readJsonDir<T>(
  dir: string,
  valid?: RegExp,
  fields: readonly string[] = [],
): Promise<T[]> {
  const out: T[] = [];
  for (const id of await jsonIds(dir, valid)) {
    try {
      const value: unknown = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), "utf8"));
      if (hasStrings(value, fields)) out.push(value as T);
    } catch {
      // Skipped, as above.
    }
  }
  return out;
}
