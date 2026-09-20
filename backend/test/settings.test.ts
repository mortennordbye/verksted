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

describe("what the page shows of a value", () => {
  it("fingerprints a stored value without ever returning it", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-abcdefghijklmnop-qrst" } },
    });
    const res = await app.inject({ url: "/api/settings" });
    const v = res.json().vars.find((v: { key: string }) => v.key === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(v.fingerprint).toBe("sk-a…qrst · 34 chars");
    // The point of the whole exercise: the value is not in the listing.
    expect(res.body).not.toContain("abcdefghijklmnop");
  });

  /** Four characters at each end of a short value would be most of it. */
  it("shows a short value's length and nothing else", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { vars: { SHORT: "abc" } } });
    const res = await app.inject({ url: "/api/settings" });
    const v = res.json().vars.find((v: { key: string }) => v.key === "SHORT");
    expect(v.fingerprint).toBe("••• · 3 chars");
    expect(res.body).not.toContain('abc"');
  });

  it("hands the whole value to the copy button, and only for what it stores", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { MINE: "secret" } },
    });
    const ok = await app.inject({ method: "POST", url: "/api/settings/vars/MINE/reveal" });
    expect(ok.json()).toEqual({ key: "MINE", value: "secret" });

    // Set in the deployment, not on this page: not this route's to hand back.
    expect(
      (await app.inject({ method: "POST", url: "/api/settings/vars/GH_TOKEN/reveal" })).statusCode,
    ).toBe(404);
    // Never storable, so never revealable.
    expect(
      (await app.inject({ method: "POST", url: "/api/settings/vars/ANTHROPIC_API_KEY/reveal" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: "/api/settings/vars/..%2f..%2fetc/reveal" }))
        .statusCode,
    ).toBe(404);
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

  // The scheduler's kill switch shares the settings file, so writing one must
  // never drop the other.
  it("toggles the schedules pause without disturbing the stored vars", async () => {
    await app.inject({ method: "PUT", url: "/api/settings", payload: { vars: { KEEP_ME: "x" } } });

    let res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { schedulesPaused: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().schedulesPaused).toBe(true);
    expect(JSON.parse(fs.readFileSync(settingsFile, "utf8")).vars.KEEP_ME).toBe("x");

    res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { schedulesPaused: false },
    });
    expect(res.json().schedulesPaused).toBe(false);
    expect(res.json().vars.find((v: { key: string }) => v.key === "KEEP_ME")).toBeTruthy();

    await app.inject({ method: "PUT", url: "/api/settings", payload: { vars: { KEEP_ME: null } } });
  });

  it("rejects ANTHROPIC_API_KEY", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { vars: { ANTHROPIC_API_KEY: "sk-ant" } },
    });
    expect(res.statusCode).toBe(400);
  });

  /**
   * Blocking that one name blocked the spelling. Each of these is the same
   * override under another (ANTHROPIC_BASE_URL sends the subscription bearer
   * and every prompt to whoever owns the host), or decides which binary a
   * session runs before the program it names gets a say.
   */
  it("rejects the rest of the family, and the loader and interpreter vars", async () => {
    for (const key of [
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "LD_PRELOAD",
      "PATH",
      "NODE_OPTIONS",
      "GIT_SSH_COMMAND",
    ]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { vars: { [key]: "x" } },
      });
      expect(res.statusCode, key).toBe(400);
    }
    // the ones that look like them and are ordinary credentials
    for (const key of ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN"]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { vars: { [key]: "x" } },
      });
      expect(res.statusCode, key).toBe(200);
    }
  });

  it("keeps a blocked var out of a session even if the file already held one", async () => {
    const stored = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
    stored.vars = { ...stored.vars, LD_PRELOAD: "/tmp/evil.so", MY_VAR: "fine" };
    fs.writeFileSync(settingsFile, JSON.stringify(stored));
    const { agentEnv } = await import("../src/settings-store.js");
    const env = await agentEnv();
    expect(env.LD_PRELOAD).toBeUndefined();
    expect(env.MY_VAR).toBe("fine");
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
