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

const readPrivate = (turn: string) =>
  app.inject({ method: "POST", url: "/api/assistant/turn/private", payload: { turn } });

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

describe("the gate a turn's web and private calls go through", () => {
  it("refuses a fetch once the turn has read something private", async () => {
    // The attack the rule exists for: nothing stopped this before, because the
    // browser was the only half that could be taken away.
    expect((await readPrivate("gate-a")).statusCode).toBe(200);

    expect(refused(await gate("gate-a", "WebFetch"))).toBe(true);
    expect(refused(await gate("gate-a", "WebSearch"))).toBe(true);
    expect(refused(await gate("gate-a", "mcp__browser__browser_navigate"))).toBe(true);
  });

  it("refuses a finance read once the turn has reached the web", async () => {
    expect(refused(await gate("gate-b", "WebFetch"))).toBe(false);

    expect(refused(await gate("gate-b", "mcp__headroom__get_overview"))).toBe(true);
  });

  it("counts a finance read as private: the browser goes and the web is shut", async () => {
    closed.length = 0;

    expect(refused(await gate("gate-c", "mcp__headroom__get_overview"))).toBe(false);

    expect(closed).toEqual(["assistant"]);
    expect(refused(await gate("gate-c", "WebFetch"))).toBe(true);
  });

  it("counts a training read as private too", async () => {
    expect(refused(await gate("gate-f", "mcp__logeverylift__recent_workouts"))).toBe(false);

    expect(refused(await gate("gate-f", "WebFetch"))).toBe(true);
  });

  it("does not let a refused fetch cost the turn its next read", async () => {
    // The stream notes a tool as it is written, before the gate has ruled on it.
    const { noteTool } = await import("../src/assistant-taint.js");
    expect((await readPrivate("gate-d")).statusCode).toBe(200);
    noteTool("gate-d", "WebFetch");
    expect(refused(await gate("gate-d", "WebFetch"))).toBe(true);

    expect((await readPrivate("gate-d")).statusCode).toBe(200);
    expect(refused(await gate("gate-d", "mcp__headroom__get_overview"))).toBe(false);
  });

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
});

describe("a turn that reads something private", () => {
  it("closes the browser it had, and does not get it back by asking again", async () => {
    // The CLI starts the browser's server before its first call on every chair
    // turn, so a started browser is not a turn that has reached the web. This
    // was a 403, and the chair could not read the calendar at all.
    expect((await start("turn-a")).statusCode).toBe(200);
    closed.length = 0;

    expect((await readPrivate("turn-a")).statusCode).toBe(200);
    expect(closed).toEqual(["assistant"]);
    expect((await start("turn-a")).statusCode).toBe(403);
  });

  it("is refused the read once the turn has used the browser", async () => {
    const { noteTool } = await import("../src/assistant-taint.js");
    expect((await start("turn-f")).statusCode).toBe(200);
    noteTool("turn-f", "mcp__browser__browser_navigate");

    expect((await readPrivate("turn-f")).statusCode).toBe(403);
  });

  it("closes it for a turn that only ever read", async () => {
    closed.length = 0;

    expect((await readPrivate("turn-b")).statusCode).toBe(200);

    expect(closed).toEqual(["assistant"]);
    const again = await start("turn-b");
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toMatch(/private/);
  });

  it("is refused the read once the turn has fetched something", async () => {
    // WebFetch and WebSearch are on the CLI's command line, fixed when the turn
    // was spawned, so they cannot be taken back the way the browser can. The
    // rule runs the other way round for them: this turn does not get to read.
    const { noteTool } = await import("../src/assistant-taint.js");
    noteTool("turn-c", "WebFetch");

    const res = await readPrivate("turn-c");

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/already reached the web/);
  });

  it("lets the next turn do either, having done neither", async () => {
    expect((await start("turn-d")).statusCode).toBe(200);
    expect((await readPrivate("turn-e")).statusCode).toBe(200);
  });

  it("leaves the person's own pane alone", async () => {
    // A tap on the browser pane carries no turn id at all: the rule is about
    // what a model may reach, not about what the person may open.
    expect((await start()).statusCode).toBe(200);
  });
});
