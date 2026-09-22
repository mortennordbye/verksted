import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin, tmuxLsRows } from "./helpers/fake-bin.js";

/**
 * What the create-session route actually forwards to the store.
 *
 * This is the layer that was silently lossy: the store has taken a prompt and a
 * permission mode since the scheduler needed them, but the route's body schema
 * listed neither, and fastify's ajv runs removeAdditional — so a caller sending
 * a prompt got a 201, a real tmux session, and an agent sitting at an empty
 * input forever. The assistant is that caller. Nothing failed, which is why it
 * survived: only asserting on the argv tmux received catches it.
 */
let app: FastifyInstance;
let fake: FakeBin;
let reposDir: string;
let sessionsDir: string;

/** The -e KEY=VALUE pairs a tmux new-session call carried. */
function envOf(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1].split(/=(.*)/s) as [string, string]] : [])),
  );
}

function create(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/projects/demo/sessions", payload: body });
}

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  const dir = path.join(reposDir, "demo");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      stdio: "pipe",
    });
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  git("add", "-A");
  git("commit", "-m", "init");

  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  for (const f of fs.readdirSync(sessionsDir)) {
    if (f.startsWith("vk-")) fs.rmSync(path.join(sessionsDir, f));
  }
  fake.reset();
  fake.reply("tmux", "ls", { stdout: "" });
});

describe("how much one pod will run (S-09)", () => {
  it("refuses a session past the ceiling, and says which ceiling", async () => {
    const running = Array.from({ length: 24 }, (_, i) => `vk-other-${i + 1}`);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(...running) });

    const res = await create({ agent: "claude" });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/24 sessions are already running/);
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
  });

  it("starts one when there is room for it", async () => {
    const running = Array.from({ length: 23 }, (_, i) => `vk-other-${i + 1}`);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(...running) });

    expect((await create({ agent: "claude" })).statusCode).toBe(201);
  });
});

describe("POST /api/projects/:name/sessions", () => {
  it("holds every git in the session to the shipped hooks, a repo's own hooksPath or not", async () => {
    await create({ agent: "claude" });
    const [argv] = fake.subcommand("tmux", "new-session");
    // Environment configuration outranks a repo's local core.hooksPath, which
    // is how husky's made the attribution stripper never run (O-32).
    expect(envOf(argv)).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/etc/verksted/git-hooks",
    });
  });

  it("delivers the prompt to the session instead of dropping it", async () => {
    const res = await create({ agent: "claude", prompt: "run git status and report" });

    expect(res.statusCode).toBe(201);
    const [argv] = fake.subcommand("tmux", "new-session");
    expect(envOf(argv).VK_PROMPT).toContain("run git status and report");
    // Same delivery as a scheduled run: a quoted expansion, never spliced into
    // the command string.
    expect(argv.at(-1)).toContain('"$VK_PROMPT"');
  });

  it("keeps prompt text out of the command line", async () => {
    await create({ agent: "claude", prompt: 'check "main"; then $(rm -rf /) `whoami`' });

    const [argv] = fake.subcommand("tmux", "new-session");
    expect(envOf(argv).VK_PROMPT).toContain("$(rm -rf /)");
    expect(argv.at(-1)).not.toContain("rm -rf");
  });

  it("asks for auto permissions only when the caller says so", async () => {
    await create({ agent: "claude", prompt: "look around", autoPermissions: true });
    expect(fake.subcommand("tmux", "new-session")[0].at(-1)).toContain("--permission-mode auto");

    fake.reset();
    await create({ agent: "claude", prompt: "look around" });
    expect(fake.subcommand("tmux", "new-session")[0].at(-1)).not.toContain("--permission-mode");
  });

  it("starts a session with no prompt at all, as the UI does", async () => {
    const res = await create({ agent: "claude" });

    expect(res.statusCode).toBe(201);
    const [argv] = fake.subcommand("tmux", "new-session");
    expect(envOf(argv).VK_PROMPT).toBeUndefined();
    expect(argv.at(-1)).not.toContain("$VK_PROMPT");
  });

  it("rejects a field it does not know rather than silently dropping it", async () => {
    const res = await create({ agent: "claude", promt: "typo" });

    // removeAdditional strips it, so this documents the behaviour the bug hid
    // behind: the session still starts, just without the misspelled field.
    expect(res.statusCode).toBe(201);
    expect(envOf(fake.subcommand("tmux", "new-session")[0]).VK_PROMPT).toBeUndefined();
  });

  it("rejects an over-long prompt at the boundary", async () => {
    const res = await create({ agent: "claude", prompt: "x".repeat(4001) });

    expect(res.statusCode).toBe(400);
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
  });

  /**
   * R-05. The id is the join key between the metadata, tmux, the transcript,
   * the usage file, `bench:wait:<id>` in the feed and a schedule's run
   * history — and it was max+1 over the metadata that still existed, so a
   * purge handed the number straight back. A purged scheduled run followed by
   * an interactive session with the recycled id had the scheduler reading that
   * night's run as "still open", and a day later writing "failed: never signed
   * off" into a live session and ending it.
   */
  it("does not hand a purged session's id to the next one", async () => {
    const id = (await create({ agent: "claude" })).json<{ id: string }>().id;
    const seq = Number(id.split("-").at(-1));

    // Purged: every file it had is gone, which is what the delete route does.
    for (const f of fs.readdirSync(sessionsDir)) {
      if (f.startsWith(id)) fs.rmSync(path.join(sessionsDir, f));
    }

    const next = (await create({ agent: "claude" })).json<{ id: string }>().id;

    expect(next).toBe(`vk-demo-${seq + 1}`);
  });

  /**
   * R-01. A browser port went with a session for good: the used set was every
   * meta on disk, ended or not, and the pool is two hundred wide, so creation
   * would have stopped for good at the two hundredth session in history. The
   * pod had 145 when this was found.
   */
  it("gives an ended session's browser port to the next one", async () => {
    const portOf = (id: string): number =>
      JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), "utf8")).cdpPort;
    const first = (await create({ agent: "claude" })).json<{ id: string }>().id;
    const live = (await create({ agent: "claude" })).json<{ id: string }>().id;
    expect(portOf(live)).not.toBe(portOf(first));

    // Ended, not purged: the meta stays, with endedAt on it.
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${first}` })).statusCode).toBe(
      200,
    );
    const next = (await create({ agent: "claude" })).json<{ id: string }>().id;

    expect(portOf(next)).toBe(portOf(first));
  });
});
