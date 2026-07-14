import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CDP_PORT_BASE, nextCdpPort, validNavUrl } from "../src/browser.js";

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
