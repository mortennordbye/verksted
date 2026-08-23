import fs from "node:fs/promises";
import { exec } from "./exec.js";
import { env } from "./env.js";
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

const NIGHTLY_EVERY_MS = 24 * 60 * 60_000;

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
  };
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
    } finally {
      running = false;
      lastFinishedAt = new Date().toISOString();
    }
  })();
  return true;
}

/**
 * The daily export, and the only reason the state on this pod is recoverable:
 * nothing here is written anywhere but the PVC, and the PVC has no snapshots.
 *
 * Its own timer rather than a line in maintenance.ts, which stays free of any
 * import of env — facts.test.ts imports it for a pure helper, and an env import
 * there would snapshot process.env before a test had finished arranging it.
 */
export function startNightly(log: Logger): void {
  if (env.VK_BACKUP_KEEP === 0) return;
  // Not on boot: a pod that crash-loops would otherwise spend every one of its
  // lives tarring the volume, and the first interval is a day out regardless.
  setInterval(() => {
    // start() logs its own outcome and never throws. False means a backup
    // someone asked for from the settings page is still going, and skipping the
    // nightly in that case is the right answer.
    if (!start(env.VK_BACKUP_KEEP, log)) {
      log.info("nightly backup skipped: one is already running");
    }
  }, NIGHTLY_EVERY_MS);
}
