import type { FastifyInstance } from "fastify";
import type { ClusterSnapshot } from "../../../shared/api.js";
import { exec } from "../exec.js";
import { ttlCache } from "../cache.js";

/**
 * What the cluster looks like from inside it.
 *
 * In the pod there is no kubeconfig: kubectl finds the projected ServiceAccount
 * token by itself, so what this can see is decided entirely by the RBAC bound to
 * that account (homelab: k8s/talos/apps/verksted/rbac.yaml — cluster-wide reads,
 * no Secrets). Anywhere else there is no token, kubectl finds no cluster, and
 * every call below fails. That is reported as `reachable: false` rather than as
 * an error, because a laptop is a normal place to run this app.
 *
 * Nothing here is a write. The one write the ServiceAccount holds — creating a
 * Kargo Promotion — is deliberately not reachable from an endpoint: it belongs
 * in a session a person can watch, like every other change this app makes.
 */

/** A read, or null if it failed for any reason — no cluster, no permission, timeout. */
async function kubectl(args: string[]): Promise<string | null> {
  try {
    // Two timeouts because they stop different things: --request-timeout ends a
    // call the apiserver is not answering, the outer one ends a kubectl that
    // never got that far (no route to the API at all, which is what a bench
    // outside the cluster looks like).
    const { stdout } = await exec("kubectl", [...args, "--request-timeout=5s"], {
      timeout: 8_000,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Header line plus the last `n` rows — these tables are read from the bottom. */
function tail(table: string, n: number): string {
  const [header, ...rows] = table.split("\n");
  return [header, ...rows.slice(-n)].join("\n");
}

/**
 * Pods that are not quietly fine, which is the only part of `get pods -A` worth
 * carrying: a healthy cluster prints a hundred rows saying so. Columns are
 * kubectl's default table — NAMESPACE NAME READY STATUS RESTARTS AGE — and the
 * STATUS one is the synthesised value a person reads (CrashLoopBackOff,
 * ImagePullBackOff, Init:0/2), not the bare pod phase.
 */
export function unhealthyPods(table: string): string {
  const [header, ...rows] = table.split("\n");
  const bad = rows.filter((row) => {
    const [, , ready = "", status = ""] = row.trim().split(/\s+/);
    // A finished Job's pod is not a problem; a Running one whose containers are
    // not all ready is exactly the case a phase check misses.
    if (status === "Completed") return false;
    const [passing, total] = ready.split("/");
    return status !== "Running" || passing !== total;
  });
  return bad.length ? [header, ...bad].join("\n") : "(all pods healthy)";
}

/**
 * Cached because this is six apiserver round trips, and the callers are a
 * polling UI and an assistant that may ask twice in one turn. Ten seconds is
 * shorter than anything here changes on its own.
 */
const snapshot = ttlCache(10_000, async (): Promise<ClusterSnapshot> => {
  const [nodes, pods, apps, stages, promotions, warnings] = await Promise.all([
    kubectl(["get", "nodes"]),
    kubectl(["get", "pods", "-A"]),
    // Argo CD's Applications all live in its own namespace; Kargo's objects are
    // one namespace per project, hence -A.
    kubectl(["get", "applications", "-n", "argocd"]),
    kubectl(["get", "stages", "-A"]),
    kubectl(["get", "promotions", "-A", "--sort-by=.metadata.creationTimestamp"]),
    kubectl(["get", "events", "-A", "--field-selector=type=Warning", "--sort-by=.lastTimestamp"]),
  ]);

  // nodes is the probe: it needs nothing but the base read the account has, so
  // failing it means no cluster rather than a missing CRD or a tight role.
  if (!nodes) return { reachable: false, sections: [] };

  const sections = [
    { title: "NODES", text: nodes },
    { title: "UNHEALTHY PODS", text: pods ? unhealthyPods(pods) : "(unreadable)" },
    { title: "ARGOCD APPLICATIONS", text: apps ?? "(unreadable)" },
    { title: "KARGO STAGES", text: stages ?? "(unreadable)" },
    { title: "RECENT PROMOTIONS", text: promotions ? tail(promotions, 8) : "(unreadable)" },
    { title: "RECENT WARNINGS", text: warnings ? tail(warnings, 10) : "(none)" },
  ];
  return { reachable: true, sections };
});

export default async function clusterRoutes(app: FastifyInstance) {
  app.get("/api/cluster", (): Promise<ClusterSnapshot> => snapshot());
}
