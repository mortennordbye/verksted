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

describe("the chair's browser", () => {
  it("starts for a turn that has read nothing", async () => {
    expect((await start("turn-a")).statusCode).toBe(200);
    expect(launched).toContain("assistant");
  });

  it("closes the moment a turn reads something private", async () => {
    closed.length = 0;

    expect((await readPrivate("turn-a")).statusCode).toBe(200);

    expect(closed).toEqual(["assistant"]);
  });

  it("does not come back for that turn by asking again", async () => {
    const res = await start("turn-a");

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toMatch(/private/);
  });

  it("starts for the next turn, which has read nothing", async () => {
    // Per turn, because that is the unit a prompt injection acts within.
    expect((await start("turn-b")).statusCode).toBe(200);
  });

  it("leaves the person's own pane alone", async () => {
    // A tap on the browser pane carries no turn id at all: the rule is about
    // what a model may reach, not about what the person may open.
    expect((await start()).statusCode).toBe(200);
  });
});
