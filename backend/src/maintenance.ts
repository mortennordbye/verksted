import fs from "node:fs/promises";
import { Cron } from "croner";
import { env } from "./env.js";
import { exec } from "./exec.js";
import { closeBrowser, unwatchedBrowsers } from "./browser.js";
import * as feed from "./feed-store.js";
import { archiveOldSessions, reapFinishedSessions } from "./session-reaper.js";
import { backfillUsage } from "./sessions-store.js";
import { pruneAssistant } from "./assistant-retention.js";
import type { Logger } from "./logger.js";

/**
 * ESTABLISHED connections to a local port, from /proc/net/tcp{,6} content.
 * Format per line: "sl local_address rem_address st ..." — address is
 * hex-ip:hex-port, st 01 = ESTABLISHED. Counts the accepting side only.
 */
export function establishedCount(tcpData: string, port: number): number {
  const hexPort = port.toString(16).toUpperCase().padStart(4, "0");
  let n = 0;
  for (const line of tcpData.split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (cols[1]?.endsWith(`:${hexPort}`) && cols[3] === "01") n++;
  }
  return n;
}

async function readTcpTables(): Promise<string> {
  let out = "";
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    out += await fs.readFile(f, "utf8").catch(() => "");
    out += "\n";
  }
  return out;
}

const REAP_AFTER_MS = 15 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
/**
 * When the daily catch-up runs, where the pod is. Past the nightly backup at
 * 03:30 and past the maintainer's stages, so a measurement is not competing
 * for the volume with the thing copying it.
 */
const HOUSEKEEPING_CRON = "20 5 * * *";
/** The session sweep's own tick. Its threshold is hours; this need not be fine. */
const SESSION_SWEEP_EVERY_MS = 10 * 60_000;

/**
 * Housekeeping for the heavyweights the sessions spawn:
 * - reap session browsers that have had no pane viewers and no external CDP
 *   clients (agents) for a while — the backend itself always holds one
 *   connection, hence the > 1 threshold. They relaunch on demand.
 * - end sessions whose agent has exited and left an idle pane behind, which
 *   otherwise read as running for good (see reapFinishedSessions).
 * - prune old docker build debris so agent images don't fill the volume. Still
 *   on a 24-hour interval from boot, which on a pod redeployed several times a
 *   day means rarely: the other half of R-02, and harmless in a way the two
 *   below are not, since nothing is lost by a prune that waits.
 * - measure the sessions that ended before there was a measurement at all. A
 *   few at a time, and it finds nothing once they all carry one: every path
 *   that ends a session measures it there and then. It ran on GET /api/usage
 *   before, where it read up to 25 transcripts on somebody opening a page.
 * - retire the sessions that ended months ago, so the directory every reader
 *   walks stays about what is live rather than about everything that ever ran.
 * - drop the assistant's unattended threads and uploads past a month (A-27).
 * - sweep the feed: done items after a month, and items nothing has touched in
 *   a month resolved first (R-20).
 */
export function startMaintenance(log: Logger): void {
  const idleSince = new Map<string, number>();

  setInterval(async () => {
    try {
      await reapIdleBrowsers(idleSince, log);
    } catch (err) {
      // An async setInterval body that throws is an unhandled rejection, and
      // one unreadable /proc entry must not take the reaper down for good.
      log.warn(err, "browser reap failed");
    }
  }, 60_000);

  setInterval(async () => {
    try {
      await reapFinishedSessions(log);
    } catch (err) {
      log.warn(err, "session sweep failed");
    }
  }, SESSION_SWEEP_EVERY_MS);

  // At a fixed hour, and once on the way up — not every 24 hours from boot.
  // This pod is redeployed several times on a busy day, and a timer counting
  // 24 hours from a start that keeps being restarted never reaches the end of
  // them: the jobs would read as scheduled and never once run (R-02, which is
  // how the nightly backup came to skip the two busiest days of a fortnight).
  //
  // Safe to repeat on every boot, which is what makes the catch-up simple:
  // both jobs ask the volume what still needs doing, and a pod that starts ten
  // times finds nothing to do nine of them.
  const catchUp = async (): Promise<void> => {
    try {
      const n = await backfillUsage();
      if (n) log.info(`measured ${n} session(s) that ended before measurement existed`);
      // After the backfill, not before: a session retired with no measurement
      // would carry that gap into the archive, where nothing measures it again.
      await archiveOldSessions(log);
    } catch (err) {
      log.warn(err, "usage backfill and retirement failed");
    }
    try {
      await pruneAssistant(log);
    } catch (err) {
      log.warn(err, "assistant prune failed");
    }
    try {
      const n = await feed.sweep();
      if (n) log.info(`feed: ${n} done item(s) swept`);
    } catch (err) {
      log.warn(err, "feed sweep failed");
    }
  };
  new Cron(HOUSEKEEPING_CRON, { protect: true, timezone: env.TZ }, () => void catchUp());
  void catchUp();

  setInterval(async () => {
    try {
      const { stdout } = await exec("docker", ["system", "prune", "-af", "--filter", "until=72h"], {
        timeout: 600_000,
      });
      log.info(`docker prune: ${stdout.trim().split("\n").at(-1) ?? "done"}`);
    } catch (err) {
      // No daemon (e.g. `make run` without dind) is normal; log and move on.
      log.warn(err, "docker prune failed");
    }
  }, PRUNE_EVERY_MS);
}

async function reapIdleBrowsers(idleSince: Map<string, number>, log: Logger): Promise<void> {
  const tcp = await readTcpTables();
  const unwatched = new Set<string>();
  for (const { id, port } of unwatchedBrowsers()) {
    unwatched.add(id);
    if (establishedCount(tcp, port) > 1) {
      idleSince.delete(id);
      continue;
    }
    const since = idleSince.get(id) ?? Date.now();
    idleSince.set(id, since);
    if (Date.now() - since >= REAP_AFTER_MS) {
      idleSince.delete(id);
      log.info(`reaping idle browser for ${id}`);
      await closeBrowser(id).catch(() => {});
    }
  }
  // Watched or already-closed browsers are not idle.
  for (const id of idleSince.keys()) {
    if (!unwatched.has(id)) idleSince.delete(id);
  }
}
