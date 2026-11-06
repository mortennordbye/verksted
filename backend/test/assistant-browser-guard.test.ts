import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The other half of the rule the MCP server pays into: a turn that has read
 * something of the person's does not get a browser, and the one it had is
 * already gone. See backend/src/assistant-taint.ts.
 */
const closed: string[] = [];
const launched: string[] = [];

vi.mock("../src/browser.js", () => ({
  ASSISTANT_BROWSER_ID: "assistant",
  ASSISTANT_CDP_PORT: 9422,
  ensureBrowser: async (id: string) => {
    launched.push(id);
    return { port: 9422 };
  },
  closeBrowser: async (id: string) => {
    closed.push(id);
  },
  addListener: async () => {},
  removeListener: () => {},
}));

let app: FastifyInstance;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

const start = (turn?: string) =>
  app.inject({
    method: "POST",
    url: "/api/assistant/browser/start",
    ...(turn ? { headers: { "x-vk-turn": turn } } : {}),
  });

/** What the verksted server reports before serving a read. */
const read = (turn: string, kind: { private?: boolean; outside?: boolean }) =>
  app.inject({
    method: "POST",
    url: "/api/assistant/turn/private",
    payload: { turn, private: false, outside: false, ...kind },
  });

const mail = (turn: string) => read(turn, { private: true, outside: true });

const gate = (turn: string | null, tool: string) =>
  app.inject({
    method: "POST",
    url: "/api/assistant/turn/gate",
    ...(turn ? { headers: { "x-vk-turn": turn } } : {}),
    payload: { tool_name: tool, tool_input: {}, session_id: "ignored" },
  });

const refused = (res: { json: () => unknown }) =>
  (res.json() as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput
    ?.permissionDecision === "deny";

describe("a turn driven only by the person", () => {
  it("reads its own finances and then the web, in one turn", async () => {
    expect(refused(await gate("own-a", "mcp__headroom__get_overview"))).toBe(false);

    expect(refused(await gate("own-a", "WebFetch"))).toBe(false);
  });

  it("reads the web and then its own finances and training", async () => {
    expect(refused(await gate("own-b", "WebSearch"))).toBe(false);

    expect(refused(await gate("own-b", "mcp__headroom__get_overview"))).toBe(false);
    expect(refused(await gate("own-b", "mcp__logeverylift__recent_workouts"))).toBe(false);
  });

  it("is never refused a read", async () => {
    expect((await mail("own-c")).statusCode).toBe(200);
    expect((await read("own-c", { private: true })).statusCode).toBe(200);
  });
});

describe("a turn that has read a stranger's text and something private", () => {
  it("cannot reach the web or the browser after a mail", async () => {
    expect((await mail("mixed-a")).statusCode).toBe(200);

    expect(refused(await gate("mixed-a", "WebFetch"))).toBe(true);
    expect(refused(await gate("mixed-a", "WebSearch"))).toBe(true);
    expect(refused(await gate("mixed-a", "mcp__browser__browser_navigate"))).toBe(true);
  });

  it("cannot fetch again after reading a page and then its finances", async () => {
    expect(refused(await gate("mixed-b", "WebFetch"))).toBe(false);
    expect(refused(await gate("mixed-b", "mcp__headroom__get_overview"))).toBe(false);

    expect(refused(await gate("mixed-b", "WebFetch"))).toBe(true);
  });

  it("closes the browser the moment it holds both, and does not give it back", async () => {
    expect((await start("mixed-c")).statusCode).toBe(200);
    expect(refused(await gate("mixed-c", "mcp__browser__browser_navigate"))).toBe(false);
    closed.length = 0;

    expect(refused(await gate("mixed-c", "mcp__headroom__get_overview"))).toBe(false);

    expect(closed).toEqual(["assistant"]);
    expect((await start("mixed-c")).statusCode).toBe(403);
  });

  it("keeps the browser for a turn that read only a stranger's text", async () => {
    closed.length = 0;

    await read("mixed-d", { outside: true });

    expect(closed).toEqual([]);
    expect((await start("mixed-d")).statusCode).toBe(200);
  });

  it("reads an older server's bare report as both", async () => {
    await app.inject({
      method: "POST",
      url: "/api/assistant/turn/private",
      payload: { turn: "mixed-e" },
    });

    expect(refused(await gate("mixed-e", "WebFetch"))).toBe(true);
  });
});

describe("the gate itself", () => {
  it("answers an error with no turn id, which the hook reads as a refusal", async () => {
    expect((await gate(null, "WebFetch")).statusCode).toBe(403);
  });

  it("rules on nothing it was not built for", async () => {
    expect(refused(await gate("gate-e", "mcp__verksted__notify"))).toBe(true);
  });

  it("gives every turn the hook, in the form that fails closed", async () => {
    const { gateSettings } = await import("../src/assistant-policy.js");
    const { GATED_TOOLS } = await import("../src/assistant-taint.js");

    const { hooks } = JSON.parse(gateSettings());
    const [entry] = hooks.PreToolUse;

    expect(entry.matcher).toBe(GATED_TOOLS);
    expect(entry.hooks[0]).toMatchObject({
      type: "http",
      onFailure: "block",
      headers: { "X-VK-Turn": "$VK_TURN" },
      allowedEnvVars: ["VK_TURN"],
    });
    expect(entry.hooks[0].url).toMatch(/\/api\/assistant\/turn\/gate$/);
  });

  it("leaves the person's own pane alone", async () => {
    // A tap on the browser pane carries no turn id at all: the rule is about
    // what a model may reach, not about what the person may open.
    expect((await start()).statusCode).toBe(200);
  });
});
