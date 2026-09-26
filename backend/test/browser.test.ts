import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  CDP_PORT_BASE,
  CDP_PORT_MAX,
  ensureBrowser,
  nextCdpPort,
  validNavUrl,
} from "../src/browser.js";
import { usedCdpPorts, type Meta } from "../src/sessions-store.js";

// Stands in for an image whose chromium is not where playwright-core looks for
// it — what a playwright bump the Dockerfile did not follow leaves behind.
vi.mock("playwright-core", () => ({
  chromium: { executablePath: () => "/opt/ms-playwright/chromium-0/chrome-linux64/chrome" },
}));

describe("validNavUrl", () => {
  it("accepts http(s) and adds a scheme when missing", () => {
    expect(validNavUrl("http://localhost:5173")).toBe("http://localhost:5173/");
    expect(validNavUrl("https://example.com/a?b=c")).toBe("https://example.com/a?b=c");
    expect(validNavUrl("localhost:8080/api/health")).toBe("http://localhost:8080/api/health");
  });

  it("rejects non-web schemes and garbage", () => {
    expect(validNavUrl("file:///etc/passwd")).toBeNull();
    expect(validNavUrl("javascript:alert(1)")).toBeNull();
    expect(validNavUrl("chrome://settings")).toBeNull();
    expect(validNavUrl("x".repeat(2001))).toBeNull();
  });

  it("refuses link-local and the cluster's service names, and keeps loopback (S-08)", () => {
    expect(validNavUrl("http://169.254.169.254/latest/meta-data")).toBeNull();
    expect(validNavUrl("http://[fe80::1]/")).toBeNull();
    expect(validNavUrl("http://kubernetes.default.svc/api")).toBeNull();
    expect(validNavUrl("http://loki.monitoring.svc.cluster.local:3100/")).toBeNull();
    expect(validNavUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173/");
    expect(validNavUrl("https://svc.example.com/")).toBe("https://svc.example.com/");
  });
});

describe("nextCdpPort", () => {
  it("hands out the lowest free port", () => {
    expect(nextCdpPort(new Set())).toBe(CDP_PORT_BASE);
    expect(nextCdpPort(new Set([CDP_PORT_BASE, CDP_PORT_BASE + 1]))).toBe(CDP_PORT_BASE + 2);
    expect(nextCdpPort(new Set([CDP_PORT_BASE + 1]))).toBe(CDP_PORT_BASE);
  });

  it("still has a port after more ended sessions than the pool is wide (R-01)", () => {
    // Every port once held by a session that has since ended, and then some:
    // only the one live session may keep its port from the next.
    const wide = CDP_PORT_MAX - CDP_PORT_BASE + 1;
    const metas = Array.from({ length: wide + 50 }, (_, i) => ({
      id: `vk-demo-${i + 1}`,
      cdpPort: CDP_PORT_BASE + (i % wide),
      endedAt: i === 0 ? null : "2026-09-01T00:00:00.000Z",
    })) as Meta[];
    expect(nextCdpPort(usedCdpPorts(metas))).toBe(CDP_PORT_BASE + 1);
  });
});

describe("ensureBrowser", () => {
  it("rejects a missing chromium binary rather than taking the backend down", async () => {
    // The spawn failure reaches the process as an 'error' event. Unhandled,
    // node throws it, and the whole backend dies with one session's browser.
    await expect(ensureBrowser("vk-demo-1", CDP_PORT_BASE)).rejects.toThrow(
      /chromium failed to start/,
    );
  });
});

describe("POST /api/sessions/:id/browser/start", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-browser-"));
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-1.json"),
      JSON.stringify({
        id: "vk-demo-1",
        project: "demo",
        agent: "claude",
        title: "t",
        createdAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
      }),
    );
    process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
    process.env.SESSIONS_DIR = sessionsDir;
    process.env.STATIC_DIR = "";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  it("404s an unknown session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/vk-ghost-9/browser/start" });
    expect(res.statusCode).toBe(404);
  });

  it("404s an ended session (no browser for dead sessions)", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/vk-demo-1/browser/start" });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/assistant/browser/start", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
    process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
    process.env.STATIC_DIR = "";
    const { buildApp } = await import("../src/app.js");
    app = await buildApp({ logger: false });
  });

  afterAll(async () => {
    await app.close();
  });

  // No id to get wrong and no session to look up — the chair's browser is
  // one fixed identity, so the only way this fails here is the same way a
  // session's does: chromium is not where playwright looks for it.
  it("502s when chromium is not there, same as a session's", async () => {
    const res = await app.inject({ method: "POST", url: "/api/assistant/browser/start" });
    expect(res.statusCode).toBe(502);
  });
});
