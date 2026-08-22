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
export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  await writeAtomic(target, JSON.stringify(value, null, 2));
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

async function writeAtomic(target: string, body: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
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
