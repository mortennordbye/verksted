import fs from "node:fs/promises";

/**
 * The few hard ceilings on what one request can cost the pod (S-09).
 *
 * There is one person on this app and a VPN in front of it, so none of this is
 * about strangers. It is about the things that arrive without one: a page
 * retrying in a loop, an agent talked into starting sessions, a clone of
 * something far larger than it looked. Each of those used to be bounded by the
 * volume filling up or the node running out of memory.
 */

/**
 * Sessions alive at once, whoever started them. Each is a tmux server entry, an
 * agent process holding a few hundred megabytes, and usually a chromium. The
 * scheduler keeps itself to six; this is the ceiling over everything.
 */
export const MAX_LIVE_SESSIONS = 24;

/** Free space a clone must leave room for, and an upload. */
export const CLONE_NEEDS_BYTES = 1024 ** 3;
export const UPLOAD_NEEDS_BYTES = 256 * 1024 ** 2;

/** Read by the app's error handler, which answers with `statusCode` and the message. */
export class LimitError extends Error {
  constructor(
    message: string,
    readonly statusCode = 429,
  ) {
    super(message);
  }
}

/** Refuse with 507 when `dir` has not got `bytes` to spare. */
export async function needRoom(dir: string, bytes: number, what: string): Promise<void> {
  if (await roomFor(dir, bytes)) return;
  throw new LimitError(`not enough free space on the volume to ${what}`, 507);
}

/**
 * Whether `dir`'s filesystem has `bytes` free. True when that cannot be told:
 * a volume that will not answer statfs is not a reason to refuse an upload.
 */
export async function roomFor(dir: string, bytes: number): Promise<boolean> {
  try {
    const stat = await fs.statfs(dir);
    return stat.bavail * stat.bsize >= bytes;
  } catch {
    return true;
  }
}

/** Requests a minute, for the routes that cost something. Used as `config.rateLimit`. */
export const perMinute = (max: number) => ({ rateLimit: { max, timeWindow: 60_000 } });
