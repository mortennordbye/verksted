import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let settingsFile: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-settings-"));
  settingsFile = path.join(dir, "settings.json");

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  process.env.SETTINGS_FILE = settingsFile;
  process.env.GH_TOKEN = "from-deployment";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/settings", () => {
  it("lists server config and known agent vars with their source, no values", async () => {
    const res = await app.inject({ url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.server.SETTINGS_FILE).toBe(settingsFile);
    const bySource = Object.fromEntries(
      body.vars.map((v: { key: string; source: string }) => [v.key, v.source]),
    );
    expect(bySource.GH_TOKEN).toBe("env");
    expect(bySource.CLAUDE_CODE_OAUTH_TOKEN).toBe("unset");
    expect(res.body).not.toContain("from-deployment");
  });
});

describe("PUT /api/settings", () => {
  it("stores a var, reports it as settings-sourced, and clears it on null", async () => {
    let res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { GH_TOKEN: "from-page", MY_VAR: "x" } },
    });
    expect(res.statusCode).toBe(200);
    let vars = Object.fromEntries(
      res.json().vars.map((v: { key: string; source: string }) => [v.key, v.source]),
    );
    expect(vars.GH_TOKEN).toBe("settings");
    expect(vars.MY_VAR).toBe("settings");
    expect(res.body).not.toContain("from-page");
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8")).vars.GH_TOKEN).toBe("from-page");

    res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { GH_TOKEN: null, MY_VAR: null } },
    });
    vars = Object.fromEntries(
      res.json().vars.map((v: { key: string; source: string }) => [v.key, v.source]),
    );
    expect(vars.GH_TOKEN).toBe("env"); // deployment value shines through again
    expect(vars.MY_VAR).toBeUndefined();
  });

  it("rejects ANTHROPIC_API_KEY", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { ANTHROPIC_API_KEY: "sk-ant" } },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects malformed keys", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { "lower-case": "x" } },
    });
    expect(res.statusCode).toBe(400);
  });
});
