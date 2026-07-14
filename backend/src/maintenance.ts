import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { closeBrowser, unwatchedBrowsers } from "./browser.js";

const exec = promisify(execFile);

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
    if (cols[1]!.endsWith(`:${hexPort}`) && cols[3] === "01") n++;
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

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

const REAP_AFTER_MS = 15 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;

/**
 * Housekeeping for the heavyweights the sessions spawn:
 * - reap session browsers that have had no pane viewers and no external CDP
 *   clients (agents) for a while — the backend itself always holds one
 *   connection, hence the > 1 threshold. They relaunch on demand.
 * - prune old docker build debris daily so agent images don't fill the volume.
 */
export function startMaintenance(log: Logger): void {
  const idleSince = new Map<string, number>();

  setInterval(async () => {
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
  }, 60_000);

  setInterval(async () => {
    try {
      const { stdout } = await exec(
        "docker",
        ["system", "prune", "-af", "--filter", "until=72h"],
        { timeout: 600_000 },
      );
      log.info(`docker prune: ${stdout.trim().split("\n").at(-1) ?? "done"}`);
    } catch (err) {
      // No daemon (e.g. `make run` without dind) is normal; log and move on.
      log.warn(err, "docker prune failed");
    }
  }, PRUNE_EVERY_MS);
}
