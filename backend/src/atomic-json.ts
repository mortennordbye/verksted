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
