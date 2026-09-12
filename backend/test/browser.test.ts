import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { CDP_PORT_BASE, ensureBrowser, nextCdpPort, validNavUrl } from "../src/browser.js";

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
});

describe("nextCdpPort", () => {
  it("hands out the lowest free port", () => {
    expect(nextCdpPort(new Set())).toBe(CDP_PORT_BASE);
    expect(nextCdpPort(new Set([CDP_PORT_BASE, CDP_PORT_BASE + 1]))).toBe(CDP_PORT_BASE + 2);
    expect(nextCdpPort(new Set([CDP_PORT_BASE + 1]))).toBe(CDP_PORT_BASE);
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
