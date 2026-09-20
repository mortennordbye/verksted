import fs from "node:fs/promises";
import { Cron } from "croner";
import { exec } from "./exec.js";
import { env } from "./env.js";
import * as feed from "./feed-store.js";
import { announce } from "./notifier.js";
import type { BackupArchive, BackupStatus } from "../../shared/api.js";

/**
 * The backup panel and the `vk` command, over one implementation.
 *
 * Nothing here reimplements what the script does: listing shells out to
 * `vk backups --json` and running shells out to `vk backup`. The panel and a
 * session terminal therefore cannot disagree about what is on disk, and the
 * rules about what an archive contains live in exactly one place.
 */

// Bare, resolved through PATH like gh and git are, so a test can put the
// repo's own copy of the script ahead of the one baked into the image.
const VK = "vk";

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/** A backup takes about a minute per 20G; this is the ceiling, not the norm. */
const RUN_TIMEOUT_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;

/** Wall-clock, in env.TZ: quiet, and after the night's unattended runs. */
const NIGHTLY_CRON = "30 3 * * *";

/** However the timer is doing, an archive this old is the thing to report. */
const STALE_AFTER_MS = 48 * 60 * 60_000;

/**
 * One run at a time, and only what this process started. Two concurrent tars
 * over the same NFS mount would each be slower than one and could interleave
 * their prunes; a second click should be told to wait, not queued.
 */
let running = false;
let lastError: string | null = null;
let lastFinishedAt: string | null = null;

export function isRunning(): boolean {
  return running;
}

export async function list(): Promise<BackupArchive[]> {
  try {
    const { stdout } = await exec(VK, ["backups", "--json"], {
      env: { ...process.env, VK_BACKUP_DIR: env.VK_BACKUP_DIR },
      timeout: 60_000,
      maxBuffer: 4 << 20,
    });
    return JSON.parse(stdout) as BackupArchive[];
  } catch {
    // A directory that does not exist yet is the first-boot case, and an old
    // image whose vk has no --json is the mid-rollout case. Both mean "nothing
    // to show" rather than a broken settings page.
    return [];
  }
}

export async function status(): Promise<BackupStatus> {
  const [archives, stat] = await Promise.all([
    list(),
    fs.statfs(env.VK_BACKUP_DIR).catch(() => ({ blocks: 0, bsize: 0, bavail: 0 })),
  ]);
  const newest = newestMs(archives);
  return {
    dir: env.VK_BACKUP_DIR,
    // The whole point of the NFS mount. When this is false the archives are on
    // the volume they exist to replace, and the page says so.
    offVolume: !env.VK_BACKUP_DIR.startsWith("/data/"),
    freeBytes: stat.bavail * stat.bsize,
    totalBytes: stat.blocks * stat.bsize,
    keep: env.VK_BACKUP_KEEP,
    archives,
    running,
    lastError,
    lastFinishedAt,
    // Read off the archives rather than off this process: lastError and
    // lastFinishedAt are module state, so a restart said everything was fine
    // no matter how long it had been since anything was written.
    stale: env.VK_BACKUP_KEEP > 0 && (newest === null || Date.now() - newest > STALE_AFTER_MS),
  };
}

/** When the newest archive this pod can account for was written, in epoch ms. */
function newestMs(archives: BackupArchive[]): number | null {
  const newest = archives.reduce((max, a) => Math.max(max, a.mtime), 0);
  return newest > 0 ? newest * 1000 : null;
}

/**
 * Start a backup and return immediately — it outlives the request by minutes,
 * so the caller polls `status()` rather than holding a connection open for it.
 * Resolves false when one is already in flight.
 */
export function start(keep: number, log: Logger): boolean {
  if (running) return false;
  running = true;
  lastError = null;
  void (async () => {
    try {
      const args = ["backup"];
      if (keep > 0) args.push("--keep", String(keep));
      const { stdout } = await exec(VK, args, {
        env: { ...process.env, VK_BACKUP_DIR: env.VK_BACKUP_DIR },
        timeout: RUN_TIMEOUT_MS,
        maxBuffer: 4 << 20,
      });
      log.info(`backup: ${stdout.split("\n").find((l) => l.startsWith("wrote ")) ?? "done"}`);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      log.warn(err, "backup failed");
      await report(lastError, log);
    } finally {
      running = false;
      lastFinishedAt = new Date().toISOString();
    }
  })();
  return true;
}

/**
 * A failed backup told nobody: lastError was a module variable a restart
 * cleared, and the only other trace was one line in the log. This is the one
 * job whose failure is invisible until the day it matters.
 */
async function report(message: string, log: Logger): Promise<void> {
  const at = new Date().toISOString();
  try {
    await feed.upsert({
      id: "bench:backup",
      source: "bench",
      at,
      title: "backup failed",
      from: "the pod",
      facts: [env.VK_BACKUP_DIR],
      detail: message.slice(0, 300),
      link: "/settings?tab=backups",
      urgency: "attention",
      // Each failure is its own event: with a constant version, a second
      // night's failure would land on an item already marked done.
      version: at,
    });
    await announce(
      {
        title: "backup failed",
        body: message.slice(0, 300),
        url: "/settings?tab=backups",
        tag: "warning",
        priority: "high",
      },
      log,
    );
  } catch (err) {
    log.warn(err, "could not report the failed backup");
  }
}

/**
 * The daily export, and the only reason the state on this pod is recoverable:
 * nothing here is written anywhere but the PVC, and the PVC has no snapshots.
 *
 * Wall-clock rather than an interval from boot. As an interval, every deploy
 * reset the 24 hours, so on a pod that ships several times a day the backup
 * never came due: the archive list had nothing at all for 14 and 15 September,
 * which are the two days that month with a dozen promotions — the busiest days
 * are exactly the ones that went unprotected.
 *
 * Its own timer rather than a line in maintenance.ts, which stays free of any
 * import of env — facts.test.ts imports it for a pure helper, and an env import
 * there would snapshot process.env before a test had finished arranging it.
 */
export function startNightly(log: Logger): Cron | null {
  if (env.VK_BACKUP_KEEP === 0) return null;
  const job = new Cron(NIGHTLY_CRON, { protect: true, timezone: env.TZ }, () => {
    // start() logs its own outcome and never throws. False means a backup
    // someone asked for from the settings page is still going, and skipping the
    // nightly in that case is the right answer.
    if (!start(env.VK_BACKUP_KEEP, log)) {
      log.info("nightly backup skipped: one is already running");
    }
  });
  void catchUp(log);
  return job;
}

/**
 * What a missed night is caught up by. Asking the archives rather than a stored
 * timer is what makes this safe to do on every boot: a pod that crash-loops
 * finds a fresh archive and does nothing.
 */
async function catchUp(log: Logger): Promise<void> {
  try {
    const newest = newestMs(await list());
    if (newest !== null && Date.now() - newest < DAY_MS) return;
    log.info(
      newest === null
        ? "no backup on disk: taking one now"
        : "the newest backup is over a day old: taking one now",
    );
    start(env.VK_BACKUP_KEEP, log);
  } catch (err) {
    log.warn(err, "could not check how old the newest backup is");
  }
}
