import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * restoreSessions decides, after a pod restart, which recorded sessions get an
 * agent started again and what command each one is given. It was verified by
 * hand only, because exercising it means really spawning tmux. A fake tmux on
 * PATH makes the decision and the argv assertable without a tmux server.
 */
let fake: FakeBin;
let sessionsDir: string;
let reposDir: string;
let store: typeof import("../src/sessions-store.js");

const log = {
  info: () => {},
  warn: () => {},
};

/** Write the metadata (and optionally the conversation id) for one session. */
function seed(
  id: string,
  opts: {
    project?: string;
    agent?: string;
    endedAt?: string | null;
    conv?: string;
    unattended?: string;
  } = {},
) {
  const project = opts.project ?? "demo";
  fs.writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      project,
      agent: opts.agent ?? "claude",
      title: id,
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: opts.endedAt ?? null,
      cdpPort: 9300,
      ...(opts.unattended ? { unattended: opts.unattended } : {}),
    }),
  );
  if (opts.conv) fs.writeFileSync(path.join(sessionsDir, `${id}.conv`), opts.conv);
}

/** The session names tmux new-session was asked to create, in order. */
function created(): string[] {
  return fake.subcommand("tmux", "new-session").map((argv) => argv[argv.indexOf("-s") + 1]);
}

/** The shell-command a session was created to run. */
function commandFor(id: string): string | undefined {
  const argv = fake.subcommand("tmux", "new-session").find((a) => a[a.indexOf("-s") + 1] === id);
  return argv?.at(-1);
}

beforeAll(async () => {
  // Before the module graph loads: tmux.ts snapshots process.env into UTF8_ENV
  // at import time, and that snapshot is what its own calls are spawned with.
  fake = FakeBin.install(["tmux"]);

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  fs.mkdirSync(path.join(reposDir, "other"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  store = await import("../src/sessions-store.js");
});

afterAll(() => {
  fake.uninstall();
});

beforeEach(() => {
  for (const f of fs.readdirSync(sessionsDir)) {
    if (/^vk-/.test(f)) fs.rmSync(path.join(sessionsDir, f));
  }
  fake.reset();
  fake.reply("tmux", "ls", { stdout: "" });
});

describe("restoreSessions", () => {
  it("fails an unattended run rather than resuming it", async () => {
    // A resumed conversation would come back without the flags that made it
    // unattended, and nobody is there to pick it up anyway. What must not
    // happen is silence: the inbox has to say the pod went down.
    seed("vk-demo-1", { conv: "11111111-2222-3333-4444-555555555555", unattended: "scout" });

    await store.restoreSessions(log);

    expect(created()).toEqual([]);
    expect(fs.readFileSync(path.join(sessionsDir, "vk-demo-1.report"), "utf8")).toMatch(
      /^failed: the pod restarted/,
    );
  });

  it("restarts a live-but-orphaned claude session on its recorded conversation", async () => {
    seed("vk-demo-1", { conv: "11111111-2222-3333-4444-555555555555" });

    await store.restoreSessions(log);

    expect(created()).toEqual(["vk-demo-1"]);
    expect(commandFor("vk-demo-1")).toContain(
      "claude --resume 11111111-2222-3333-4444-555555555555",
    );
  });

  it("starts the agent as the session's own command, not by typing into its pane", async () => {
    // send-keys races the pane shell's startup: a command sent before the shell
    // is reading is dropped, leaving a session with no agent in it.
    seed("vk-demo-1", { conv: "11111111-1111-1111-1111-111111111111" });

    await store.restoreSessions(log);

    expect(fake.subcommand("tmux", "send-keys")).toEqual([]);
    // The trailing exec is what keeps the session alive once the agent exits —
    // that shell is how a crashed agent is restarted in the same session.
    expect(commandFor("vk-demo-1")).toMatch(/; exec "\$\{SHELL:-\/bin\/sh\}"$/);
  });

  it("starts the agent in the session's own project directory", async () => {
    seed("vk-other-1", { project: "other", conv: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });

    await store.restoreSessions(log);

    const argv = fake.subcommand("tmux", "new-session")[0];
    expect(argv[argv.indexOf("-c") + 1]).toBe(fs.realpathSync(path.join(reposDir, "other")));
  });

  it("leaves alone the sessions that must not be restarted", async () => {
    // Still live on the new tmux server: restarting would run a second agent
    // against the same conversation.
    seed("vk-demo-1", { conv: "11111111-1111-1111-1111-111111111111" });
    // Already over.
    seed("vk-demo-2", {
      endedAt: "2026-01-02T00:00:00.000Z",
      conv: "22222222-2222-2222-2222-222222222222",
    });
    // No recorded conversation: --continue would pick the newest one for the
    // directory, which is another session's.
    seed("vk-demo-3");
    // Only claude reports its conversation id, so only claude can be resumed.
    seed("vk-demo-4", { agent: "codex", conv: "44444444-4444-4444-4444-444444444444" });
    // The project directory is gone.
    seed("vk-gone-1", { project: "gone", conv: "55555555-5555-5555-5555-555555555555" });
    fake.reply("tmux", "ls", { stdout: "vk-demo-1\n" });

    await store.restoreSessions(log);

    expect(created()).toEqual([]);
  });

  it("restores nothing when tmux cannot be reached, rather than guessing", async () => {
    seed("vk-demo-1", { conv: "11111111-1111-1111-1111-111111111111" });
    // Not "no server running" — tmux itself is broken, so the live set is
    // unknown. Restoring on a guess would double every running agent.
    fake.reply("tmux", "ls", { code: 1, stderr: "connect failed: permission denied" });

    await store.restoreSessions(log);

    expect(created()).toEqual([]);
  });

  it("treats an empty tmux server as an empty live set, not as a failure", async () => {
    seed("vk-demo-1", { conv: "11111111-1111-1111-1111-111111111111" });
    fake.reply("tmux", "ls", { code: 1, stderr: "no server running on /tmp/tmux-0/default" });

    await store.restoreSessions(log);

    expect(created()).toEqual(["vk-demo-1"]);
  });

  it("keeps going when one session cannot be restored", async () => {
    seed("vk-gone-1", { project: "gone", conv: "11111111-1111-1111-1111-111111111111" });
    seed("vk-demo-9", { conv: "99999999-9999-9999-9999-999999999999" });

    await store.restoreSessions(log);

    expect(created()).toEqual(["vk-demo-9"]);
  });

  it("passes the session's own env into tmux, so hooks write to the right files", async () => {
    seed("vk-demo-1", { conv: "11111111-1111-1111-1111-111111111111" });

    await store.restoreSessions(log);

    const argv = fake.subcommand("tmux", "new-session")[0];
    const env = Object.fromEntries(
      argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1].split(/=(.*)/s) as [string, string]] : [])),
    );
    expect(env.VK_SESSION_ID).toBe("vk-demo-1");
    expect(env.VK_STATE_FILE).toBe(path.join(sessionsDir, "vk-demo-1.state"));
    expect(env.VK_CONV_FILE).toBe(path.join(sessionsDir, "vk-demo-1.conv"));
  });

  it("never lets a doctored conversation id reach the pane's shell", async () => {
    // The resume command is delivered with send-keys, which types it into a
    // shell — so the id is the one value in this path that is shell syntax.
    seed("vk-demo-1", { conv: "abc; rm -rf /" });
    seed("vk-demo-2", { conv: "$(id)" });
    seed("vk-demo-3", { conv: "`whoami`" });

    await store.restoreSessions(log);

    expect(created()).toEqual([]);
  });
});
