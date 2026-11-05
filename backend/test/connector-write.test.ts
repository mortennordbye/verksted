import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FeedItem } from "../../shared/api.js";

/**
 * A change in another service, as a card. headroom's server here is a real stdio
 * process speaking MCP through the real SDK client, with `tsx` swapped for a small
 * script that records what it is asked. Only the tap should ever reach `add_goal`.
 */
let app: FastifyInstance;
let calls: string;
let store: typeof import("../src/settings-store.js");

const SERVER = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const rl = require("node:readline").createInterface({ input: process.stdin });
const tools = [
  { name: "add_goal", description: "x", inputSchema: { type: "object", properties: {}, required: ["name"] } },
  { name: "delete_goal", description: "x", inputSchema: { type: "object", properties: {} } },
];
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  let result = {};
  if (m.method === "initialize") result = { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "h", version: "1" } };
  if (m.method === "tools/list") result = { tools };
  if (m.method === "tools/call") {
    appendFileSync(process.env.CLAUDE_VK_TEST_CALLS, JSON.stringify(m.params) + "\\n");
    result = m.params.name === "delete_goal"
      ? { content: [{ type: "text", text: "no such goal" }], isError: true }
      : { content: [{ type: "text", text: "added" }] };
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }) + "\\n");
});
`;

beforeAll(async () => {
  const repos = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  const bin = path.join(repos, "headroom/node_modules/.bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "tsx"), SERVER, { mode: 0o755 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-write-"));
  calls = path.join(dir, "calls.log");
  fs.writeFileSync(calls, "");
  process.env.REPOS_DIR = repos;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.STATIC_DIR = "";
  // turnEnv lets the CLAUDE_ prefix through, which is how the script hears this.
  process.env.CLAUDE_VK_TEST_CALLS = calls;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  store = await import("../src/settings-store.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  fs.writeFileSync(calls, "");
  await store.writeVars({ HEADROOM_URL: "https://h.example", HEADROOM_PASSWORD: "pw" });
});

const propose = (action: Record<string, unknown>) =>
  app.inject({
    method: "POST",
    url: "/api/proposals",
    payload: { action: { kind: "connector_write", ...action } },
  });

const addGoal = { connector: "headroom", tool: "add_goal", args: { name: "Car", target: 1000 } };

const called = () => fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean);

describe("a write as a card", () => {
  it("changes nothing when it is filed, and shows the whole call", async () => {
    const res = await propose(addGoal);

    expect(res.statusCode, res.body).toBeLessThan(300);
    const item = res.json<FeedItem>();
    expect(item.title).toBe("Headroom: add goal");
    expect(JSON.stringify(item)).toContain("Car");
    expect(called()).toEqual([]);
  });

  it("runs on the tap, through the real client, exactly as shown", async () => {
    const item = (await propose(addGoal)).json<FeedItem>();

    const res = await app.inject({
      method: "POST",
      url: `/api/proposals/${encodeURIComponent(item.id)}/do`,
    });

    expect(res.statusCode, res.body).toBeLessThan(300);
    expect(called().map((c) => JSON.parse(c))).toEqual([
      { name: "add_goal", arguments: { name: "Car", target: 1000 } },
    ]);
  });

  it("refuses a read, a denied tool, and a write the table leaves off", async () => {
    for (const tool of ["get_overview", "get_raw_data", "restore_revision", "set_ai_context"]) {
      const res = await propose({ connector: "headroom", tool, args: {} });
      expect(res.statusCode, tool).toBeGreaterThanOrEqual(400);
    }
    expect(called()).toEqual([]);
  });

  it("refuses a connector that does not exist", async () => {
    const res = await propose({ connector: "bank", tool: "add_goal", args: {} });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("refuses at filing a call missing what the tool requires", async () => {
    const res = await propose({ connector: "headroom", tool: "add_goal", args: {} });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("name");
  });

  it("refuses at filing a tool the server no longer has", async () => {
    const res = await propose({ connector: "headroom", tool: "add_bonus", args: {} });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("no tool");
  });

  it("says so when the tool reports an error, rather than calling it done", async () => {
    const item = (
      await propose({ connector: "headroom", tool: "delete_goal", args: {} })
    ).json<FeedItem>();

    const res = await app.inject({
      method: "POST",
      url: `/api/proposals/${encodeURIComponent(item.id)}/do`,
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.body).toContain("no such goal");
  });
});

describe("the writes a card may ask for", () => {
  it("are never on a turn's allow list", async () => {
    const { CONNECTORS, CONNECTOR_READS } = await import("../src/assistant-connectors.js");
    const { policyFor, unattendedPolicy } = await import("../src/assistant-policy.js");
    const { chair } = await import("../src/council-store.js");
    const allowed = [...policyFor(await chair()).allowed, ...unattendedPolicy().allowed];

    for (const c of CONNECTORS) {
      for (const tool of c.writes) {
        expect(allowed).not.toContain(`mcp__${c.id}__${tool}`);
        expect(c.reads).not.toContain(tool);
      }
    }
    expect(allowed.filter((t) => t === "mcp__headroom" || t === "mcp__logeverylift")).toEqual([]);
    expect(CONNECTOR_READS.length).toBeGreaterThan(0);
  });
});
