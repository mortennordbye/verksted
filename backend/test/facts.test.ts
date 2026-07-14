import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { establishedCount } from "../src/maintenance.js";

let app: FastifyInstance;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-s-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/facts", () => {
  it("reports disk, memory and browser counts", async () => {
    const res = await app.inject({ url: "/api/facts" });
    expect(res.statusCode).toBe(200);
    const facts = res.json();
    expect(facts.diskTotal).toBeGreaterThan(0);
    expect(facts.diskFree).toBeGreaterThan(0);
    expect(facts.memUsed).toBeGreaterThan(0);
    expect(facts.browsers).toBe(0);
  });
});

describe("GET /api/ports", () => {
  it("returns a port list", async () => {
    const res = await app.inject({ url: "/api/ports" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});

describe("establishedCount", () => {
  // 0x23FA = 9210; state 01 = ESTABLISHED, 0A = LISTEN.
  const tcp = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:23FA 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 100",
    "   1: 0100007F:23FA 0100007F:A001 01 00000000:00000000 00:00000000 00000000     0        0 101",
    "   2: 0100007F:23FA 0100007F:A002 01 00000000:00000000 00:00000000 00000000     0        0 102",
    "   3: 0100007F:A001 0100007F:23FA 01 00000000:00000000 00:00000000 00000000     0        0 103",
  ].join("\n");

  it("counts only established connections accepted on the port", () => {
    expect(establishedCount(tcp, 0x23fa)).toBe(2);
    expect(establishedCount(tcp, 4321)).toBe(0);
  });
});
