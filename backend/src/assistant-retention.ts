import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.js";
import { uploadsDir } from "./assistant-policy.js";

interface Logger {
  info: (msg: string) => void;
}

/**
 * How long the assistant keeps what nobody asked it to keep (A-27).
 *
 * Two directories grow for good otherwise: the unattended threads, which a
 * nightly briefing and a nightly harvest add some seven hundred of a year, and
 * the uploads, every image pasted into the chat and every screenshot a turn
 * took. Neither is what recall is for. The briefing already landed in the
 * inbox, and an image is part of the moment it was sent in.
 *
 * The person's own conversations are not touched. They are the history recall
 * searches, and deleting one is a decision rather than a cleanup.
 */
export const ASSISTANT_RETAIN_DAYS = 30;

/** A file's age is its last write: an unattended thread is finished when its run is. */
async function pruneOlder(
  dir: string,
  cutoff: number,
  keep: (name: string) => boolean,
): Promise<number> {
  const names = await fs.readdir(dir).catch(() => []);
  let n = 0;
  for (const name of names) {
    if (!keep(name)) continue;
    const file = path.join(dir, name);
    const stat = await fs.lstat(file).catch(() => null);
    // A plain file only: a directory or a link here is not something this wrote.
    if (!stat?.isFile() || stat.mtimeMs > cutoff) continue;
    await fs.rm(file, { force: true });
    n++;
  }
  return n;
}

export async function pruneAssistant(log: Logger, now = Date.now()): Promise<number> {
  const cutoff = now - ASSISTANT_RETAIN_DAYS * 24 * 60 * 60_000;
  const threads = await pruneOlder(path.join(env.ASSISTANT_DIR, "unattended"), cutoff, (name) =>
    name.endsWith(".jsonl"),
  );
  const uploads = await pruneOlder(uploadsDir(), cutoff, () => true);
  if (threads || uploads) {
    log.info(
      `pruned ${threads} unattended thread(s) and ${uploads} upload(s) older than ${ASSISTANT_RETAIN_DAYS} days`,
    );
  }
  return threads + uploads;
}
