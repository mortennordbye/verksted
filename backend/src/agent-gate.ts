import fs from "node:fs/promises";
import os from "node:os";
import type { FastifyRequest } from "fastify";
import { agentUser } from "./agent-user.js";

/**
 * Whether a request came from something an agent can steer, and if so, the
 * little it may ask for (root cause 1, S-04(b), S-05, S-08).
 *
 * There is no auth in this app: WireGuard is the boundary, and everything on
 * the pod is inside it. A session's agent could `curl` the backend and start a
 * session with no guard on it, reveal a stored token, or tap its own proposal;
 * the assistant's chromium could do the same from a page on the app's origin.
 * With agents under their own uid, the kernel says who is on the other end of
 * a connection made on this pod, and that is what is read here.
 *
 * - From loopback or one of the pod's own addresses: the connecting socket is
 *   in /proc/net/tcp with its owner's uid. The agent user's is an agent's; a
 *   socket that cannot be found is treated as one too, since this refuses.
 * - From a docker bridge on the pod (the dind sidecar shares its network): a
 *   container an agent started. Always an agent's.
 * - From anywhere else: the ingress, or the kubelet's probe. The network
 *   policy admits nothing else, and the ingress path out of the pod is closed
 *   by the egress policy beside it.
 *
 * Nothing changes with no agent user configured.
 */

/** What a session's own tooling calls: `vk feedback`, and the browser MCP's boot. */
const AGENT_ROUTES: { method: string; url: string }[] = [
  { method: "POST", url: "/api/feedback" },
  { method: "POST", url: "/api/sessions/:id/browser/start" },
  { method: "GET", url: "/api/health" },
];

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

function bare(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address;
}

/** The pod's own addresses, and the subnets of its docker bridges. */
function localNetworks(): { own: Set<string>; bridges: { base: number; mask: number }[] } {
  const own = new Set<string>();
  const bridges: { base: number; mask: number }[] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      own.add(bare(a.address));
      if (a.family === "IPv4" && (name.startsWith("docker") || name.startsWith("br-"))) {
        const mask = ipv4(a.netmask);
        bridges.push({ base: ipv4(a.address) & mask, mask });
      }
    }
  }
  return { own, bridges };
}

function ipv4(address: string): number {
  return address.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0) >>> 0;
}

/**
 * The uid owning the client end of a connection to `serverPort` from
 * `clientPort`, out of /proc/net/tcp content. Columns: sl, local, remote, st,
 * queues, timer, retransmits, uid. Ports are the last four hex digits of an
 * address, in either table.
 */
export function socketOwner(tables: string, clientPort: number, serverPort: number): number | null {
  const hex = (port: number) => port.toString(16).toUpperCase().padStart(4, "0");
  const client = `:${hex(clientPort)}`;
  const server = `:${hex(serverPort)}`;
  for (const line of tables.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 8) continue;
    if (cols[1]?.endsWith(client) && cols[2]?.endsWith(server)) return Number(cols[7]);
  }
  return null;
}

async function readTables(): Promise<string> {
  const parts = await Promise.all(
    ["/proc/net/tcp", "/proc/net/tcp6"].map((f) => fs.readFile(f, "utf8").catch(() => "")),
  );
  return parts.join("\n");
}

/** Whether the request came from something running as the agent user. */
export async function fromAgent(req: FastifyRequest): Promise<boolean> {
  const agent = agentUser();
  if (!agent) return false;
  const remote = bare(req.socket.remoteAddress ?? "");
  const { own, bridges } = localNetworks();
  if (LOOPBACK.test(remote) || own.has(remote)) {
    const owner = socketOwner(
      await readTables(),
      req.socket.remotePort ?? -1,
      req.socket.localPort ?? -1,
    );
    return owner === null || owner === agent.uid;
  }
  if (remote.includes(".")) {
    const ip = ipv4(remote);
    if (bridges.some((b) => (ip & b.mask) === b.base)) return true;
  }
  return false;
}

/** Whether this request is one an agent may make: its own few routes, or not from an agent. */
export async function agentMay(req: FastifyRequest): Promise<boolean> {
  if (!agentUser()) return true;
  const url = req.routeOptions.url;
  if (AGENT_ROUTES.some((r) => r.method === req.method && r.url === url)) return true;
  return !(await fromAgent(req));
}
