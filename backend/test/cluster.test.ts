import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { unhealthyPods } from "../src/routes/cluster.js";

/** Every kubectl argv the route asked for, and what to answer with. */
const calls: string[][] = [];
let reply: (args: string[]) => string = () => "";

vi.mock("../src/exec.js", () => ({
  exec: async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { stdout: reply(args), stderr: "" };
  },
}));

let app: FastifyInstance;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-cluster-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-cluster-s-"));
  process.env.STATIC_DIR = "";
  // The snapshot is cached for ten seconds, so the two route cases below would
  // otherwise be one answer served twice. Only Date is faked; the http server
  // and its timers are left alone.
  vi.useFakeTimers({ toFake: ["Date"] });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  vi.useRealTimers();
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
  it("reports unreachable rather than failing when there is no cluster", async () => {
    reply = () => {
      throw new Error("The connection to the server localhost:8080 was refused");
    };
    const res = await app.inject({ url: "/api/cluster" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ reachable: false, sections: [] });
  });

  it("never passes --request-timeout, which would disable in-cluster config", async () => {
    // The flag puts a Timeout on the merged client config, so it stops comparing
    // equal to kubectl's built-in default — and that equality is what kubectl
    // tests before falling back to the projected ServiceAccount token. With the
    // flag, every read silently goes to http://localhost:8080 instead, which in
    // the pod is this backend answering 200 with index.html.
    vi.setSystemTime(Date.now() + 60_000); // past the snapshot's ten-second cache
    calls.length = 0;
    reply = (args) => (args[1] === "pods" ? PODS : "NAME   STATUS\nx      Ready");

    const res = await app.inject({ url: "/api/cluster" });

    expect(res.json().reachable).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[0]).toBe("kubectl");
      expect(argv.join(" ")).not.toContain("--request-timeout");
    }
  });
});
