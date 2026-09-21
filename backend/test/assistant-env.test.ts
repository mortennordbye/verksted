import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * What a turn can read and what it is handed (A-06).
 *
 * FakeBin records an argv, and half of this is about the environment, which no
 * argv shows. So this file puts its own `claude` on PATH: a shell that writes
 * down its arguments and its environment, keyed by whose persona it was given,
 * and answers like the real one.
 */
let dir: string;
let home: string;
let settingsFile: string;
let oldPath: string | undefined;
let app: FastifyInstance;

const ANSWER = [
  JSON.stringify({ type: "system", subtype: "init" }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Fine." }] } }),
  JSON.stringify({ type: "result", subtype: "success", is_error: false }),
].join("\n");

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-env-"));
  fs.writeFileSync(
    path.join(dir, "claude"),
    [
      "#!/bin/sh",
      'who=chair; case "$*" in *"Your name is Michael."*) who=michael;; *"Your name is Sophia."*) who=sophia;; esac',
      `env > ${dir}/$who.env`,
      `for a in "$@"; do printf '%s\\n' "$a"; done > ${dir}/$who.argv`,
      `cat <<'EOF'\n${ANSWER}\nEOF`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  process.env.HOME = home;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "vk-env-data-"));
  settingsFile = path.join(data, "settings.json");
  process.env.SETTINGS_FILE = settingsFile;
  process.env.ASSISTANT_DIR = path.join(data, "assistant");
  process.env.COUNCIL_DIR = path.join(data, "council");
  process.env.MEMORY_DIR = path.join(data, "memory");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  // What the deployment sets for the backend and a turn has no use for.
  process.env.VK_BACKUP_PASSPHRASE = "backend-only";
  process.env.LC_TIME = "nb_NO.UTF-8";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  const { seedCouncil } = await import("../src/council-store.js");
  await seedCouncil();
  const { writeVars } = await import("../src/settings-store.js");
  await writeVars({
    GH_TOKEN: "ghp_for_sessions",
    OPENAI_API_KEY: "sk-for-codex",
    CLAUDE_CODE_OAUTH_TOKEN: "the-sign-in",
    HEADROOM_URL: "https://headroom.example",
    HEADROOM_PASSWORD: "hunter2",
  });
});

afterAll(async () => {
  await app.close();
  process.env.PATH = oldPath;
  delete process.env.VK_BACKUP_PASSPHRASE;
  delete process.env.LC_TIME;
});

beforeEach(() => {
  for (const f of fs.readdirSync(dir)) if (f !== "claude") fs.rmSync(path.join(dir, f));
});

const say = (text: string) =>
  app.inject({ method: "POST", url: "/api/assistant/messages", payload: { text } });

function envOf(who: string): Record<string, string> {
  const lines = fs.readFileSync(path.join(dir, `${who}.env`), "utf8").split("\n");
  return Object.fromEntries(
    lines.filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), "set"]),
  );
}

function argvOf(who: string): string[] {
  return fs.readFileSync(path.join(dir, `${who}.argv`), "utf8").split("\n");
}

const after = (argv: string[], flag: string) => argv[argv.indexOf(flag) + 1] ?? "";

describe("what a turn may read", () => {
  it("has no read rule that reaches outside the repos", async () => {
    await say("hello");
    const argv = argvOf("chair");

    // The tools exist, and inside the working directory they need no rule. An
    // allow rule with no path is what opened the rest of the disk.
    expect(after(argv, "--tools").split(",")).toEqual(
      expect.arrayContaining(["Read", "Grep", "Glob"]),
    );
    const allowed = after(argv, "--allowed-tools").split(" ");
    for (const tool of ["Read", "Grep", "Glob"]) expect(allowed).not.toContain(tool);
    // And a call no rule covers is refused, not put to a classifier.
    expect(after(argv, "--permission-mode")).toBe("dontAsk");
  });

  it("denies the places that hold credentials, whatever else changes", async () => {
    await say("hello");
    const denied = after(argvOf("chair"), "--disallowed-tools").split(" ");

    expect(denied).toContain("Read(//proc/**)");
    expect(denied).toContain(`Read(/${home}/**)`);
    expect(denied).toContain(`Read(/${settingsFile})`);
  });

  it("holds an advisor to the same", async () => {
    await say("@michael what is degraded?");
    const argv = argvOf("michael");

    expect(after(argv, "--allowed-tools").split(" ")).not.toContain("Read");
    expect(after(argv, "--permission-mode")).toBe("dontAsk");
    expect(after(argv, "--disallowed-tools")).toContain(`Read(/${settingsFile})`);
  });

  it("gives the advisor that reads the web no way to read a repo", async () => {
    // A repo is where the .env files are, and a fetch is how one leaves.
    await say("@sophia what changed in node 24?");
    const tools = after(argvOf("sophia"), "--tools").split(",");

    expect(tools).toContain("WebFetch");
    for (const tool of ["Read", "Grep", "Glob"]) expect(tools).not.toContain(tool);
  });
});

describe("what a turn is handed", () => {
  it("gets the sign-in, the locale and a PATH, and none of the session's credentials", async () => {
    await say("hello");
    const env = envOf("chair");

    for (const key of ["PATH", "HOME", "LC_TIME", "CLAUDE_CODE_OAUTH_TOKEN", "VK_TURN"]) {
      expect(env, key).toHaveProperty(key);
    }
    for (const key of ["GH_TOKEN", "OPENAI_API_KEY", "VK_BACKUP_PASSPHRASE", "SETTINGS_FILE"]) {
      expect(env, key).not.toHaveProperty(key);
    }
  });

  it("hands headroom's password to the speakers that are offered headroom, and no one else", async () => {
    await say("hello");
    expect(envOf("chair")).toHaveProperty("HEADROOM_PASSWORD");

    await say("@michael what is degraded?");
    const env = envOf("michael");
    expect(env).not.toHaveProperty("HEADROOM_PASSWORD");
    expect(env).not.toHaveProperty("HEADROOM_URL");
    expect(env).toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });
});
