import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { unhealthyPods } from "../src/routes/cluster.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-cluster-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-cluster-s-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

// Real `kubectl get pods -A` output: one healthy pod, one finished Job, one
// crash-looping, and one that is Running with a container short of ready —
// the last being the case a pod-phase check silently passes.
const PODS = [
  "NAMESPACE     NAME                        READY   STATUS             RESTARTS   AGE",
  "verksted      verksted-app-685d8-c6v6x    2/2     Running            0          3d",
  "kargo-cd      verksted-promote-x9k2z      0/1     Completed          0          5h",
  "monitoring    loki-backend-0              0/1     CrashLoopBackOff   9          22m",
  "argocd        argocd-repo-server-77f4d    1/2     Running            0          8m",
].join("\n");

describe("unhealthyPods", () => {
  it("keeps the broken pods and the header", () => {
    const out = unhealthyPods(PODS);
    expect(out).toContain("NAMESPACE");
    expect(out).toContain("loki-backend-0");
    expect(out).toContain("argocd-repo-server-77f4d");
  });

  it("drops healthy pods and finished Job pods", () => {
    const out = unhealthyPods(PODS);
    expect(out).not.toContain("verksted-app-685d8-c6v6x");
    expect(out).not.toContain("verksted-promote-x9k2z");
  });

  it("says so rather than printing a bare header when nothing is wrong", () => {
    const healthy = PODS.split("\n").filter((l) => l.includes("Running") && l.includes("2/2"));
    expect(unhealthyPods([PODS.split("\n")[0], ...healthy].join("\n"))).toBe("(all pods healthy)");
  });
});

describe("GET /api/cluster", () => {
  // The test container has no ServiceAccount token, so this exercises the
  // no-cluster path: an answer, not a 500.
  it("reports unreachable rather than failing when there is no cluster", async () => {
    const res = await app.inject({ url: "/api/cluster" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reachable: false, sections: [] });
  });
});
