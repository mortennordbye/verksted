import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import type { ListeningPort, PodFacts } from "../../../shared/api.js";
import { browserCount } from "../browser.js";
import { env } from "../env.js";

const exec = promisify(execFile);

/** cgroup-v2 aware memory usage; falls back to OS totals outside a limit. */
async function memory(): Promise<{ used: number; total: number }> {
  try {
    const used = Number(await fs.readFile("/sys/fs/cgroup/memory.current", "utf8"));
    const maxRaw = (await fs.readFile("/sys/fs/cgroup/memory.max", "utf8")).trim();
    return { used, total: maxRaw === "max" ? os.totalmem() : Number(maxRaw) };
  } catch {
    return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
  }
}

async function dockerDf(): Promise<PodFacts["docker"]> {
  try {
    const { stdout } = await exec(
      "docker",
      ["system", "df", "--format", "{{.Type}}\t{{.Size}}\t{{.Reclaimable}}"],
      { timeout: 5_000 },
    );
    return stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [type = "", size = "", reclaimable = ""] = line.split("\t");
        return { type, size, reclaimable };
      });
  } catch {
    return null; // no daemon reachable
  }
}

/** Listening TCP ports in this network namespace, with owning process names. */
async function podListeners(): Promise<ListeningPort[]> {
  const byInode = new Map<string, number>();
  for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const data = await fs.readFile(file, "utf8").catch(() => "");
    for (const line of data.split("\n").slice(1)) {
      const cols = line.trim().split(/\s+/);
      // st 0A = LISTEN; cols: sl local rem st tx rx tr retrnsmt uid timeout inode
      if (cols.length < 10 || cols[3] !== "0A") continue;
      const port = parseInt(cols[1]!.split(":").at(-1)!, 16);
      if (port === env.PORT || port === 5173) continue; // the app itself
      byInode.set(cols[9]!, port);
    }
  }
  const names = new Map<number, string>();
  if (byInode.size > 0) {
    const pids = (await fs.readdir("/proc").catch(() => [])).filter((d) => /^\d+$/.test(d));
    for (const pid of pids) {
      const fds = await fs.readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of fds) {
        const link = await fs.readlink(`/proc/${pid}/fd/${fd}`).catch(() => "");
        const m = /^socket:\[(\d+)\]$/.exec(link);
        const port = m && byInode.get(m[1]!);
        if (port && !names.has(port)) {
          names.set(port, (await fs.readFile(`/proc/${pid}/comm`, "utf8").catch(() => "?")).trim());
        }
      }
    }
  }
  return [...new Set(byInode.values())].map((port) => ({
    port,
    process: names.get(port) ?? "?",
    url: `http://127.0.0.1:${port}`,
  }));
}

/** Ports published by containers on the docker daemon (dev: the dind service). */
async function dockerPorts(): Promise<ListeningPort[]> {
  try {
    const { stdout } = await exec("docker", ["ps", "--format", "{{.Names}}\t{{.Ports}}"], {
      timeout: 5_000,
    });
    // In dev, published ports live on the dind service's interface; in the pod
    // (shared netns sidecar) DOCKER_HOST is 127.0.0.1 and so are the ports.
    const host = process.env.DOCKER_HOST ? new URL(process.env.DOCKER_HOST).hostname : "127.0.0.1";
    const out: ListeningPort[] = [];
    for (const line of stdout.split("\n").filter(Boolean)) {
      const [name = "", ports = ""] = line.split("\t");
      for (const m of ports.matchAll(/(?:\d+\.\d+\.\d+\.\d+|\[::\]):(\d+)->/g)) {
        const port = Number(m[1]);
        if (!out.some((p) => p.port === port)) {
          out.push({ port, process: name, url: `http://${host}:${port}` });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

export default async function factsRoutes(app: FastifyInstance) {
  app.get("/api/facts", async (): Promise<PodFacts> => {
    const [stat, mem, docker] = await Promise.all([
      fs.statfs(env.REPOS_DIR),
      memory(),
      dockerDf(),
    ]);
    return {
      diskTotal: stat.blocks * stat.bsize,
      diskFree: stat.bavail * stat.bsize,
      memUsed: mem.used,
      memTotal: mem.total,
      browsers: browserCount(),
      docker,
    };
  });

  app.get("/api/ports", async (): Promise<ListeningPort[]> => {
    const [pod, docker] = await Promise.all([podListeners(), dockerPorts()]);
    // Chromium CDP ports are infrastructure, not previews.
    return [...pod, ...docker]
      .filter((p) => p.port < 9222 || p.port > 9421)
      .sort((a, b) => a.port - b.port);
  });
}
