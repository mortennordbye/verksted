import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
// Imported with the app rather than at the top of the file: maintenance reaches
// env.ts through the session sweep, and env snapshots process.env the first time
// it is imported — a static import here would freeze REPOS_DIR at its default
// before the line below points it at a temp dir, and the disk facts would then
// be measured on a path that does not exist.
let establishedCount: typeof import("../src/maintenance.js").establishedCount;

beforeAll(async () => {
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-s-"));
  process.env.STATIC_DIR = "";
  // What each agent signs in with is read from these and nothing else.
  process.env.SETTINGS_FILE = path.join(process.env.SESSIONS_DIR, "settings.json");
  for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "ANTIGRAVITY_API_KEY"]) {
    delete process.env[key];
  }
  const { buildApp } = await import("../src/app.js");
  ({ establishedCount } = await import("../src/maintenance.js"));
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

describe("the agents in GET /api/facts (Milestone 4)", () => {
  it("says what each would sign in with, and counts the MCP servers it gets", async () => {
    const realHome = process.env.HOME;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-home-"));
    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } }),
    );
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { one: {}, two: {} } }),
    );
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[mcp_servers.docs]\ncommand = "x"\n',
    );
    process.env.HOME = home;
    try {
      const { agents } = (await app.inject({ url: "/api/facts" })).json();
      expect(agents).toEqual([
        // The browser every session gets, and the user's two.
        { agent: "claude", auth: "login", mcp: 3 },
        { agent: "codex", auth: "none", mcp: 1 },
        { agent: "antigravity", auth: "none", mcp: null },
      ]);
      // Never the credential itself.
      expect(JSON.stringify(agents)).not.toContain('"r"');
    } finally {
      process.env.HOME = realHome;
    }
  });
});

describe("headroom in GET /api/facts (backlog)", () => {
  it("says nothing where headroom is not set up, and what is missing where it is", async () => {
    expect((await app.inject({ url: "/api/facts" })).json().headroom).toBeNull();

    fs.writeFileSync(
      process.env.SETTINGS_FILE!,
      JSON.stringify({ vars: { HEADROOM_URL: "http://h", HEADROOM_PASSWORD: "p" } }),
    );
    const repo = path.join(process.env.REPOS_DIR!, "headroom");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/redesign\n");
    try {
      expect((await app.inject({ url: "/api/facts" })).json().headroom).toEqual({
        branch: "redesign",
        missing: ["mcp/server.ts", "node_modules/.bin/tsx"],
      });
      fs.mkdirSync(path.join(repo, "mcp"));
      fs.writeFileSync(path.join(repo, "mcp", "server.ts"), "");
      fs.mkdirSync(path.join(repo, "node_modules", ".bin"), { recursive: true });
      fs.writeFileSync(path.join(repo, "node_modules", ".bin", "tsx"), "");
      expect((await app.inject({ url: "/api/facts" })).json().headroom.missing).toEqual([]);
    } finally {
      fs.rmSync(process.env.SETTINGS_FILE!, { force: true });
      fs.rmSync(repo, { recursive: true, force: true });
    }
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
