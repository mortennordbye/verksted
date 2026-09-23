import { exec } from "../exec.js";
import fs from "node:fs/promises";
import os from "node:os";
import type { FastifyInstance } from "fastify";
import type { AgentFact, ListeningPort, PodFacts } from "../../../shared/api.js";
import { browserCount } from "../browser.js";
import { ttlCache } from "../cache.js";
import { env } from "../env.js";
import { claudeCredentialsFile } from "../claude-home.js";
import { credential } from "../settings-store.js";

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

const home = () => process.env.HOME ?? "/data/home";

/**
 * What each agent would sign in with, read the way each CLI finds it: a
 * credential from the settings page or the environment first, then the login
 * the CLI keeps for itself. Only whether one is there, never what it is.
 */
async function agentFacts(): Promise<AgentFact[]> {
  const exists = (file: string) =>
    fs.access(file).then(
      () => true,
      () => false,
    );
  // claude: an OAuth token, else its own login, which it refreshes as it runs
  // as long as the refresh token is there (see plan.ts for the same order).
  let claude: AgentFact["auth"] = "none";
  if (await credential("CLAUDE_CODE_OAUTH_TOKEN")) claude = "token";
  else {
    try {
      const raw = JSON.parse(await fs.readFile(claudeCredentialsFile(), "utf8")) as {
        claudeAiOauth?: { accessToken?: string; refreshToken?: string };
      };
      if (raw.claudeAiOauth?.refreshToken || raw.claudeAiOauth?.accessToken) claude = "login";
    } catch {
      // No login on the volume.
    }
  }
  // Every claude session gets the browser server (claude-hooks.ts), plus any
  // the user added to its own config.
  let claudeMcp = 1;
  try {
    const cfg = JSON.parse(await fs.readFile(`${home()}/.claude.json`, "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    claudeMcp += Object.keys(cfg.mcpServers ?? {}).length;
  } catch {
    // No user config: the browser alone.
  }

  const codex: AgentFact["auth"] = (await credential("OPENAI_API_KEY"))
    ? "key"
    : (await exists(`${home()}/.codex/auth.json`))
      ? "login"
      : "none";
  const codexToml = await fs.readFile(`${home()}/.codex/config.toml`, "utf8").catch(() => "");
  const codexMcp = (codexToml.match(/^\[mcp_servers\.[^\]]+\]/gm) ?? []).length;

  return [
    { agent: "claude", auth: claude, mcp: claudeMcp },
    { agent: "codex", auth: codex, mcp: codexMcp },
    // Where agy keeps a login of its own has not been confirmed on the pod
    // (BACKLOG), so only the key is read, and its MCP config not at all.
    {
      agent: "antigravity",
      auth: (await credential("ANTIGRAVITY_API_KEY")) ? "key" : "none",
      mcp: null,
    },
  ];
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
      const [, local = "", , , , , , , , inode = ""] = cols;
      const port = parseInt(local.split(":").at(-1) ?? "", 16);
      if (port === env.PORT || port === 5173) continue; // the app itself
      byInode.set(inode, port);
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
        const port = m?.[1] ? byInode.get(m[1]) : undefined;
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
    const host = env.DOCKER_HOST ? new URL(env.DOCKER_HOST).hostname : "127.0.0.1";
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
    const [stat, mem, docker, agents] = await Promise.all([
      // One unreadable mount must not 500 the whole facts endpoint, which also
      // carries memory, browser count and the docker figures.
      fs.statfs(env.REPOS_DIR).catch(() => ({ blocks: 0, bsize: 0, bavail: 0 })),
      memory(),
      dockerDf(),
      agentFacts(),
    ]);
    return {
      diskTotal: stat.blocks * stat.bsize,
      diskFree: stat.bavail * stat.bsize,
      memUsed: mem.used,
      memTotal: mem.total,
      browsers: browserCount(),
      docker,
      agents,
    };
  });

  // podListeners readlinks every fd of every pid; with chromium around that is
  // thousands of syscalls, and the UI polls this from each open session tab. A
  // preview port appearing three seconds late costs nothing.
  const ports = ttlCache(3_000, async (): Promise<ListeningPort[]> => {
    const [pod, docker] = await Promise.all([podListeners(), dockerPorts()]);
    // Chromium CDP ports are infrastructure, not previews.
    return [...pod, ...docker]
      .filter((p) => p.port < 9222 || p.port > 9421)
      .sort((a, b) => a.port - b.port);
  });

  app.get("/api/ports", () => ports());
}
