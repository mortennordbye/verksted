import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scheduledJobs } from "croner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeBin, tmuxLsRows } from "./helpers/fake-bin.js";

/**
 * What a fired schedule actually does. schedules.test.ts covers the store and
 * the routes, but stops at the point runSchedule would start something — so the
 * parts that matter in the pod were untested: that a tick really launches a
 * claude session in the right repo, that the prompt is delivered through the
 * environment rather than the command line, that an unattended run gets
 * --permission-mode auto, and that a tick is skipped while the previous run is
 * still open.
 *
 * A fake tmux on PATH makes all of that assertable. git stays real, so the
 * default-branch sync createSession does first is exercised too.
 */
let fake: FakeBin;
let reposDir: string;
let sessionsDir: string;
let schedulesDir: string;
let scheduler: typeof import("../src/scheduler.js");
let store: typeof import("../src/schedules-store.js");

const log = { info: () => {}, warn: () => {} };

/** A cron that cannot fire during the run: every launch here is "run now". */
const CRON = "17 4 1 1 *";

const councilDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-council-"));

async function schedule(prompt: string, project = "demo") {
  return store.createSchedule({ name: "nightly", project, cron: CRON, prompt });
}

/** A maintainer stage: the shipped prompt, run in a session that cannot ask. */
async function stageSchedule(
  notes = "",
  project = "demo",
  stage: "scout" | "build" | "gate" = "scout",
) {
  return store.createSchedule({
    name: stage,
    project,
    cron: CRON,
    prompt: notes,
    stage,
  });
}

/** What gh answers when asked for the queue: one issue, or none. */
function queued(issues: { number: number; title: string; tier?: string; body?: string }[]) {
  fake.reply("gh", "issue list", {
    stdout: JSON.stringify(
      issues.map((i) => ({
        number: i.number,
        title: i.title,
        body: i.body ?? "",
        url: `https://github.com/o/demo/issues/${i.number}`,
        updatedAt: "2026-08-29T00:00:00Z",
        labels: [{ name: "queued" }, ...(i.tier ? [{ name: `tier:${i.tier}` }] : [])],
      })),
    ),
  });
}

/** The other kind: it runs the assistant instead of starting a session. */
async function assistantSchedule(prompt: string) {
  return store.createSchedule({
    name: "briefing",
    kind: "assistant",
    project: "",
    cron: CRON,
    prompt,
  });
}

/** A stream-json run from the fake claude that says `text` and exits. */
function reply(text: string): string {
  return (
    [
      JSON.stringify({ type: "system", subtype: "init" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ].join("\n") + "\n"
  );
}

/** The -e KEY=VALUE pairs a tmux new-session call carried. */
function envOf(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1].split(/=(.*)/s) as [string, string]] : [])),
  );
}

beforeAll(async () => {
  fake = FakeBin.install(["tmux", "claude", "gh"]);

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  const dir = path.join(reposDir, "demo");
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
  // The repo's side of the maintainer: what a stage run is told about it.
  fs.writeFileSync(
    path.join(dir, "CLAUDE.md"),
    "# demo\n\n## Maintainer\n\nVerify: `npm test`.\n\n## Other\n\nnot for the maintainer\n",
  );
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], {
    stdio: "pipe",
  });
  execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "init"],
    { stdio: "pipe" },
  );

  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  schedulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-assist-"));
  // The scheduler pushes a broken run itself. Both channels are wired here so
  // that path is the real one: the devices file lands in a temp dir rather than
  // /data, and the topic is a port nothing listens on, so a test that does not
  // stub fetch fails the send instantly and swallows it, as the pod would.
  process.env.PUSH_FILE = path.join(process.env.ASSISTANT_DIR, "push.json");
  process.env.NTFY_URL = "http://127.0.0.1:1/verksted";
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = schedulesDir;
  process.env.COUNCIL_DIR = councilDir;
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.MAINTAINER_DIR = path.resolve(import.meta.dirname, "../../runtime/maintainer");
  process.env.STATIC_DIR = "";
  scheduler = await import("../src/scheduler.js");
  store = await import("../src/schedules-store.js");
});

afterAll(() => {
  fake.uninstall();
});

beforeEach(() => {
  for (const d of [sessionsDir, schedulesDir]) {
    for (const f of fs.readdirSync(d)) {
      if (/^(vk-|sch-)/.test(f)) fs.rmSync(path.join(d, f));
    }
  }
  fake.reset();
  fake.reply("tmux", "ls", { stdout: "" });
  fake.reply("claude", "-p", { stdout: reply("ok: nothing needs you.") });
});

/** The session a firing started, since a run may now produce a reply instead. */
async function sessionFrom(id: string) {
  const outcome = await scheduler.runSchedule(id, log);
  return outcome && "session" in outcome ? outcome.session : null;
}

describe("runSchedule", () => {
  it("starts a claude session in the schedule's project", async () => {
    const s = await schedule("check the open PRs");

    const session = await sessionFrom(s.id);

    expect(session).not.toBeNull();
    expect(session!.project).toBe("demo");
    expect(session!.agent).toBe("claude");
    // The schedule's name becomes the session title, so the inbox row and the
    // session row say the same thing.
    expect(session!.title).toBe("nightly");
    const argv = fake.subcommand("tmux", "new-session")[0];
    expect(argv[argv.indexOf("-s") + 1]).toBe(session!.id);
    expect(argv[argv.indexOf("-c") + 1]).toBe(fs.realpathSync(path.join(reposDir, "demo")));
  });

  it("delivers the prompt through the environment, not the command line", async () => {
    // The prompt is user text. If it were spliced into the command string that
    // tmux types into the pane's shell, a quote or a $( ) in it would be shell
    // syntax; as a quoted expansion of an env var it cannot be.
    const s = await schedule('merge "approved" PRs; then $(rm -rf /) `whoami`');

    await scheduler.runSchedule(s.id, log);

    const [argv] = fake.subcommand("tmux", "new-session");
    expect(envOf(argv).VK_PROMPT).toContain('merge "approved" PRs; then $(rm -rf /) `whoami`');
    const command = argv.at(-1)!;
    expect(command).toContain('"$VK_PROMPT"');
    expect(command).not.toContain("rm -rf");
  });

  it("asks the run to sign off with one line, so silence is not mistaken for ok", async () => {
    const s = await schedule("check the open PRs");

    await scheduler.runSchedule(s.id, log);

    const prompt = envOf(fake.subcommand("tmux", "new-session")[0]).VK_PROMPT;
    expect(prompt).toContain("$VK_REPORT_FILE");
    expect(prompt).toMatch(/"ok: <summary>"/);
    expect(prompt).toMatch(/"attention: <summary>"/);
    expect(prompt).toMatch(/"failed: <summary>"/);
  });

  it("tells the run that having something to read is not being stuck", async () => {
    // The calibration, not just the vocabulary. Asked only "which needs me?", a
    // run that had finished and left a list to read signed off "attention" —
    // which put a done run in "needs a decision" and woke a phone for it. If
    // this wording goes, that comes back, and nothing else would catch it.
    const s = await schedule("propose some improvements");

    await scheduler.runSchedule(s.id, log);

    const prompt = envOf(fake.subcommand("tmux", "new-session")[0]).VK_PROMPT;
    expect(prompt).toMatch(/only if this cannot go any further without me/);
    expect(prompt).toMatch(/not the same as being stuck/);
    // And a stated default to fall back on, so a close call does not escalate.
    expect(prompt).toMatch(/write "ok"/);
  });

  it("runs unattended in auto permission mode", async () => {
    // Nobody is there at 07:00 to answer a permission prompt.
    const s = await schedule("check the open PRs");

    await scheduler.runSchedule(s.id, log);

    expect(fake.subcommand("tmux", "new-session")[0].at(-1)).toContain("--permission-mode auto");
  });

  it("skips a tick while the previous run is still open, and records why", async () => {
    const s = await schedule("check the open PRs");
    const first = await sessionFrom(s.id);
    // The session the first run started is still live on the tmux server.
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(first!.id) });
    fake.reset();

    const second = await scheduler.runSchedule(s.id, log);

    expect(second).toBeNull();
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
    expect((await store.getSchedule(s.id))!.lastError).toMatch(/still open/);
  });

  it("fires again once the previous run has finished", async () => {
    const s = await schedule("check the open PRs");
    await scheduler.runSchedule(s.id, log);
    fake.reset();

    // tmux still lists nothing, so the first session reads as done.
    expect(await scheduler.runSchedule(s.id, log)).not.toBeNull();
    expect(fake.subcommand("tmux", "new-session")).toHaveLength(1);
  });

  it("starts one session when a tick and a run-now overlap", async () => {
    // The "still open" guard reads lastSessionId, which is only written after
    // createSession returns — and createSession syncs the default branch and
    // spawns tmux first. Anything that fires inside that window reads the same
    // stale "nothing is open" and starts a second agent in the same worktree.
    const s = await schedule("check the open PRs");

    const started = (
      await Promise.all([scheduler.runSchedule(s.id, log), scheduler.runSchedule(s.id, log)])
    ).filter(Boolean);

    expect(fake.subcommand("tmux", "new-session")).toHaveLength(1);
    expect(started).toHaveLength(1);
  });

  it("carries what the run left in the repo onto its inbox row", async () => {
    // The evidence behind the sign-off: a run that reports itself ok and
    // committed nothing is the case this is for.
    const s = await schedule("check the open PRs");
    const session = await sessionFrom(s.id);
    // Its tmux session is gone, so the next list sweep ends it and measures.
    fake.reply("tmux", "ls", { stdout: "" });

    const run = (await store.listRuns()).find((r) => r.sessionId === session!.id);

    expect(run!.work).toEqual({
      commits: 0,
      files: 0,
      dirty: 0,
      // The test repo has no remote, so there is no upstream to count against.
      unpushed: null,
      branch: "main",
    });
  });

  it("records the reason rather than throwing when the project is gone", async () => {
    const s = await schedule("check the open PRs", "deleted-repo");

    expect(await scheduler.runSchedule(s.id, log)).toBeNull();
    expect((await store.getSchedule(s.id))!.lastError).toBeTruthy();
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
  });

  it("returns null for an id that no longer exists", async () => {
    expect(await scheduler.runSchedule("sch-deadbeef", log)).toBeNull();
  });
});

describe("a schedule that runs a maintainer stage", () => {
  /** The settings file the run was started with. */
  function settingsOf(argv: string[]): {
    hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    permissions: { allow: string[]; deny: string[] };
  } {
    const file = /--settings "([^"]+)"/.exec(argv.at(-1)!)![1];
    return JSON.parse(fs.readFileSync(file, "utf8"));
  }

  it("runs headless, in a mode that denies rather than asks", async () => {
    const s = await stageSchedule();

    const session = await sessionFrom(s.id);

    expect(session!.unattended).toBe("scout");
    const [argv] = fake.subcommand("tmux", "new-session");
    const command = argv.at(-1)!;
    // -p: the prompt is an argument and the process exits when the turn ends,
    // which is what lets the scheduler know the run is over.
    expect(command).toMatch(/--permission-mode dontAsk --max-turns \d+ --verbose -p "\$VK_PROMPT"/);
    expect(command).not.toContain("--permission-mode auto");
    // And the pane asks for the verdict a silent run did not write, then says
    // the agent is gone, since tmux will not. That order matters: the exit
    // file is what lets the watcher end the session.
    expect(command).toContain(
      '"$VK_PROMPT"; vk_code=$?; vk-signoff "$vk_code"; printf %s "$vk_code" > "$VK_EXIT_FILE"',
    );
    const env = envOf(argv);
    expect(env.VK_UNATTENDED).toBe("1");
    expect(env.VK_STAGE).toBe("scout");
    expect(env.VK_PROJECT).toBe("demo");
    expect(env.VK_WORKTREE).toBe(fs.realpathSync(path.join(reposDir, "demo")));
  });

  it("gets hooks that guard rather than wait, and a deny list under them", async () => {
    const s = await stageSchedule();

    await scheduler.runSchedule(s.id, log);

    const settings = settingsOf(fake.subcommand("tmux", "new-session")[0]);
    const guard = settings.hooks.PreToolUse.find((h) => h.matcher);
    expect(guard!.matcher).toBe("Bash|Edit|Write|MultiEdit|NotebookEdit");
    expect(guard!.hooks[0].command).toBe("vk-guard");
    // Stop never writes "waiting": nobody is being waited for. It writes the
    // report the run forgot instead, so silence is recorded as a failure.
    const stop = settings.hooks.Stop.flatMap((h) => h.hooks.map((x) => x.command)).join(" ");
    expect(stop).not.toContain("waiting");
    expect(stop).toContain("failed: no sign-off");
    expect(settings.hooks.Notification).toBeUndefined();
    expect(settings.permissions.allow).toContain("Bash");
    expect(settings.permissions.deny).toContain("Bash(git push --force*)");
    // And an ordinary schedule is untouched by any of it.
    fake.reset();
    await scheduler.runSchedule((await schedule("check the open PRs")).id, log);
    const plain = settingsOf(fake.subcommand("tmux", "new-session")[0]);
    expect(plain.hooks.Stop[0].hooks[0].command).toContain("waiting");
    expect(plain.permissions.deny).toBeUndefined();
  });

  it("hands the run the shipped prompt, the repo's contract and the owner's notes", async () => {
    const s = await stageSchedule("skip the desktop app tonight");

    await scheduler.runSchedule(s.id, log);

    const prompt = envOf(fake.subcommand("tmux", "new-session")[0]).VK_PROMPT;
    expect(prompt).toMatch(/^You are the maintainer's scout/);
    expect(prompt).toContain("Verify: `npm test`.");
    expect(prompt).not.toContain("not for the maintainer");
    expect(prompt).toContain("skip the desktop app tonight");
    // The same sign-off as every other scheduled run.
    expect(prompt).toContain("$VK_REPORT_FILE");
  });

  it("ends the session once the agent has exited, failing one that left no report", async () => {
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    // The pane is back at its shell: the headless agent is gone.
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.exit`), "0");

    await scheduler.watchUnattended(log);

    expect(fake.subcommand("tmux", "kill-session").map((a) => a.at(-1))).toContain(
      `=${session!.id}`,
    );
    expect((await store.getSchedule(s.id))!.lastReport).toBe("failed: no sign-off (exit 0)");
  });

  it("puts the agent's last line into the verdict when it left no report", async () => {
    // A headless claude that cannot start says why on the pane and exits. The
    // pane is about to be ended, so that line has to travel in the report or
    // it is gone — and "no sign-off" alone would send someone to a pod that
    // no longer has the session.
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.exit`), "1");
    fake.reply("tmux", "capture-pane", {
      stdout:
        "$ claude -p ...\nerror: unknown option '--permission-mode'\n\nroot@pod:/data/repos/demo# \n",
    });

    await scheduler.watchUnattended(log);

    expect((await store.getSchedule(s.id))!.lastReport).toBe(
      "failed: no sign-off (exit 1, last line: error: unknown option '--permission-mode')",
    );
    // The whole tail is kept behind the first line, for whoever opens the file.
    const file = fs.readFileSync(path.join(sessionsDir, `${session!.id}.report`), "utf8");
    expect(file).toContain("$ claude -p ...");
  });

  it("keeps a run's own report when it wrote one", async () => {
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.report`), "ok: filed 2\n");
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.exit`), "0");

    await scheduler.watchUnattended(log);

    expect((await store.getSchedule(s.id))!.lastReport).toBe("ok: filed 2");
    expect((await store.listRuns())[0].outcome).toBe("ok");
  });

  it("leaves a run alone while its agent is still going", async () => {
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });

    await scheduler.watchUnattended(log);

    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
    expect((await store.getSchedule(s.id))!.lastReport).toBeNull();
  });

  it("kills a run at the cap and says so", async () => {
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });

    await scheduler.watchUnattended(log, Date.now() + scheduler.UNATTENDED_CAP_MS + 1);

    expect(fake.subcommand("tmux", "kill-session").map((a) => a.at(-1))).toContain(
      `=${session!.id}`,
    );
    expect((await store.getSchedule(s.id))!.lastReport).toMatch(/^failed: killed after 90 minutes/);
  });

  it("does not touch a session a person started", async () => {
    const s = await schedule("check the open PRs");
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.exit`), "0");

    await scheduler.watchUnattended(log, Date.now() + scheduler.UNATTENDED_CAP_MS + 1);

    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
  });
});

describe("a schedule that runs the build stage", () => {
  it("starts nothing when the queue is empty, and says so", async () => {
    queued([]);
    const s = await stageSchedule("", "demo", "build");

    expect(await scheduler.runSchedule(s.id, log)).toBeNull();

    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
    expect((await store.getSchedule(s.id))!.lastError).toBe("queue empty");
  });

  it("takes the oldest queued issue into a worktree of its own", async () => {
    queued([
      { number: 43, title: "later", tier: "review" },
      { number: 42, title: "add a test for parseLocaleNumber", tier: "auto", body: "thin space" },
    ]);
    const s = await stageSchedule("", "demo", "build");

    const session = await sessionFrom(s.id);

    // A sibling project, on a branch named for the issue; the repo stays put.
    const dir = fs.realpathSync(path.join(reposDir, "demo--maint-42"));
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
    expect(execFileSync("git", ["-C", dir, "branch", "--show-current"]).toString().trim()).toBe(
      "maint/42",
    );
    expect(
      execFileSync("git", ["-C", path.join(reposDir, "demo"), "branch", "--show-current"])
        .toString()
        .trim(),
    ).toBe("main");
    expect(session!.project).toBe("demo--maint-42");
    expect(session!.title).toBe("build · #42");
    const [argv] = fake.subcommand("tmux", "new-session");
    expect(argv[argv.indexOf("-c") + 1]).toBe(dir);
    const env = envOf(argv);
    expect(env.VK_STAGE).toBe("build");
    expect(env.VK_ISSUE).toBe("42");
    expect(env.VK_WORKTREE).toBe(dir);
    expect(env.VK_PROMPT).toMatch(/^You are the maintainer's builder/);
    expect(env.VK_PROMPT).toContain("#42: add a test for parseLocaleNumber");
    expect(env.VK_PROMPT).toContain("Tier: auto");
    expect(env.VK_PROMPT).toContain("Branch: maint/42");
    expect(env.VK_PROMPT).toContain("thin space");
    // And the issue is claimed, so the next tick does not take it again.
    expect(fake.subcommand("gh", "issue")).toContainEqual([
      "issue",
      "edit",
      "42",
      "--remove-label",
      "queued",
      "--add-label",
      "in-progress",
    ]);
  });

  it("removes the worktree once the build is over and everything reached the remote", async () => {
    queued([{ number: 44, title: "x", tier: "auto" }]);
    const s = await stageSchedule("", "demo", "build");
    const session = await sessionFrom(s.id);
    const dir = path.join(reposDir, "demo--maint-44");
    expect(fs.existsSync(dir)).toBe(true);
    // The agent has exited and tmux no longer lists the session.
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.exit`), "0");
    fs.writeFileSync(path.join(sessionsDir, `${session!.id}.report`), "ok: PR #9 opened\n");
    fake.reply("tmux", "ls", { stdout: "" });

    await scheduler.watchUnattended(log);

    expect(fs.existsSync(dir)).toBe(false);
    // The repo forgot the worktree too; the branch is still there.
    const list = execFileSync("git", [
      "-C",
      path.join(reposDir, "demo"),
      "worktree",
      "list",
    ]).toString();
    expect(list).not.toContain("demo--maint-44");
    const branches = execFileSync("git", ["-C", path.join(reposDir, "demo"), "branch"]).toString();
    expect(branches).toContain("maint/44");
  });

  it("runs the gate in the repo itself, with its own prompt", async () => {
    const s = await stageSchedule("", "demo", "gate");

    const session = await sessionFrom(s.id);

    expect(session!.project).toBe("demo");
    const env = envOf(fake.subcommand("tmux", "new-session")[0]);
    expect(env.VK_STAGE).toBe("gate");
    expect(env.VK_PROMPT).toMatch(/^You are the maintainer's gate/);
    expect(env.VK_PROMPT).toContain("--squash --auto");
  });
});

describe("a schedule that runs the assistant", () => {
  it("answers with a reply and starts no session at all", async () => {
    const s = await assistantSchedule("what needs me today?");

    const outcome = await scheduler.runSchedule(s.id, log);

    expect(outcome).toEqual({ reply: "ok: nothing needs you." });
    // The whole distinction: no tmux, no repo, no terminal to attach to.
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
  });

  it("files what it said as the run's own report", async () => {
    // There is no session to have written a report file, so the reply is it —
    // which is what puts an assistant run in the inbox next to every other one.
    const s = await assistantSchedule("what needs me today?");

    await scheduler.runSchedule(s.id, log);

    const after = (await store.getSchedule(s.id))!;
    expect(after.lastReport).toBe("ok: nothing needs you.");
    expect(after.lastSessionId).toBeNull();
    expect((await store.listRuns()).find((r) => r.scheduleId === s.id)?.outcome).toBe("ok");
  });

  it("runs with no tool that could change anything", async () => {
    const s = await assistantSchedule("what needs me today?");

    await scheduler.runSchedule(s.id, log);

    const [argv] = fake.argvFor("claude");
    // The web goes too: with nobody reading, fetch is the exfiltration half of
    // a prompt injection and a briefing has no use for it.
    expect(argv[argv.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    const denied = argv[argv.indexOf("--disallowed-tools") + 1];
    for (const tool of ["Bash", "Edit", "Write", "WebFetch", "WebSearch"]) {
      expect(denied, tool).toContain(tool);
    }
    // And the verksted tools are cut at the server, which is the only place a
    // tool can be made not to exist rather than merely not auto-approved.
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: { verksted: { env: Record<string, string> } };
    };
    expect(config.mcpServers.verksted.env.VK_UNATTENDED).toBe("1");
  });

  it("gets its own conversation, so it never touches the one being read", async () => {
    const s = await assistantSchedule("what needs me today?");

    await scheduler.runSchedule(s.id, log);
    await scheduler.runSchedule(s.id, log);

    const ids = fake
      .argvFor("claude")
      .map((argv) => argv[argv.indexOf("--session-id") + 1])
      .filter(Boolean);
    // Named, never resumed: a briefing is a standing question with no yesterday
    // in it, and resuming one would re-send every previous morning.
    expect(new Set(ids).size).toBe(2);
    expect(fake.argvFor("claude").every((argv) => !argv.includes("--resume"))).toBe(true);
  });

  it("does not run at all on a day when nothing ended", async () => {
    // The cheapest turn is the one that never starts. A harvest has nothing to
    // read when no session ended, and finding that out from inside the turn
    // would cost the same model call as finding something.
    const idle = await store.createSchedule({
      name: "memory harvest",
      kind: "assistant",
      project: "",
      cron: CRON,
      prompt: "learn from yesterday",
      skipWhenIdle: true,
    });

    expect(await scheduler.skipForIdle((await store.getSchedule(idle.id))!)).toBe(true);

    // One session that ended an hour ago, and there is something to read.
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-7.json"),
      JSON.stringify({
        id: "vk-demo-7",
        project: "demo",
        agent: "claude",
        title: "t",
        createdAt: new Date(Date.now() - 7_200_000).toISOString(),
        endedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
    );

    expect(await scheduler.skipForIdle((await store.getSchedule(idle.id))!)).toBe(false);
  });

  it("runs the advisor a schedule names, in that advisor's voice", async () => {
    // A cluster briefing at 07:00 is worth more from the one that watches the
    // cluster than from the chair relaying it. One advisor, one model call: a
    // schedule never holds a meeting, because the daily ceiling counts turns.
    const { saveMember } = await import("../src/council-store.js");
    await saveMember({
      id: "michael",
      name: "Michael",
      remit: "the cluster",
      tools: ["cluster_status"],
    });
    const s = await store.createSchedule({
      name: "cluster briefing",
      kind: "assistant",
      project: "",
      cron: CRON,
      prompt: "anything degraded?",
      member: "michael",
    });
    fake.reset();
    fake.reply("claude", "-p", { stdout: reply("ok: nothing degraded.") });

    const out = await scheduler.runSchedule(s.id, log);

    expect(out).toEqual({ reply: "ok: nothing degraded." });
    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).toContain("Your name is Michael.");
    // Unattended still means unattended: it keeps its own tools but loses the
    // web and everything that changes anything.
    expect(argv[argv.indexOf("--disallowed-tools") + 1]).toContain("WebFetch");
    const config = JSON.parse(fs.readFileSync(argv[argv.indexOf("--mcp-config") + 1], "utf8")) as {
      mcpServers: { verksted: { env: Record<string, string> } };
    };
    expect(config.mcpServers.verksted.env.VK_UNATTENDED).toBe("1");
    expect(config.mcpServers.verksted.env.VK_TOOLS).toBe("cluster_status");
  });

  it("falls back to the chair when a schedule names nobody", async () => {
    const s = await assistantSchedule("what needs me today?");
    fake.reset();
    fake.reply("claude", "-p", { stdout: reply("ok: quiet.") });

    await scheduler.runSchedule(s.id, log);

    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).not.toContain("sits on the council");
  });

  it("lets a briefing ask the council, and charges every turn it costs", async () => {
    const { saveMember } = await import("../src/council-store.js");
    await saveMember({ id: "michael", name: "Michael", remit: "the cluster", tools: [] });
    await saveMember({ id: "raphael", name: "Raphael", remit: "the code", tools: [] });
    const s = await store.createSchedule({
      name: "morning",
      kind: "assistant",
      project: "",
      cron: CRON,
      prompt: "anything for me?",
      convenes: true,
    });
    fake.reset();
    fake.reply("claude", "-p", { stdout: reply("convene: michael, raphael") });
    fake.reply("claude", "-p", {
      contains: "Your name is Michael.",
      stdout: reply("Cluster fine."),
    });
    fake.reply("claude", "-p", {
      contains: "Your name is Raphael.",
      stdout: reply("Two PRs open."),
    });
    fake.reply("claude", "-p The council answered.", {
      stdout: reply("attention: two PRs need you."),
    });
    // A fresh registry, because the day's count is module state and a meeting
    // spends four of it — otherwise this test quietly starves the ones below.
    vi.resetModules();
    const fresh = await import("../src/scheduler.js");

    const out = await fresh.runSchedule(s.id, log);

    // Four calls: the chair twice and both advisors once, and the sign-off is
    // the chair's rather than whichever advisor happened to finish last.
    expect(out).toEqual({ reply: "attention: two PRs need you." });
    expect(fake.argvFor("claude")).toHaveLength(4);
    // The advisors were unattended too: no web, and no tools that change things.
    const [michael] = fake
      .argvFor("claude")
      .filter((argv) => argv.join(" ").includes("Your name is Michael."));
    expect(michael[michael.indexOf("--disallowed-tools") + 1]).toContain("WebFetch");
    const config = JSON.parse(
      fs.readFileSync(michael[michael.indexOf("--mcp-config") + 1], "utf8"),
    ) as { mcpServers: { verksted: { env: Record<string, string> } } };
    expect(config.mcpServers.verksted.env.VK_UNATTENDED).toBe("1");
  });

  it("does not let a briefing convene unless it was asked to", async () => {
    // Turning this on turns one call into as many as five, so an existing
    // schedule must not start holding meetings because a roster appeared.
    const { saveMember } = await import("../src/council-store.js");
    await saveMember({ id: "michael", name: "Michael", remit: "the cluster", tools: [] });
    const s = await assistantSchedule("what needs me today?");
    fake.reset();
    fake.reply("claude", "-p", { stdout: reply("convene: michael") });
    vi.resetModules();
    const fresh = await import("../src/scheduler.js");

    await fresh.runSchedule(s.id, log);

    // One call, and the convene line stands as the answer because nothing was
    // listening for it.
    expect(fake.argvFor("claude")).toHaveLength(1);
    const [argv] = fake.argvFor("claude");
    expect(argv[argv.indexOf("--append-system-prompt") + 1]).not.toContain("You chair a council");
  });

  it("never skips a briefing that did not ask to be skipped", async () => {
    // A briefing reports on things that happen without a session ending — a PR
    // somebody else opened, a build that went red — so the idle rule is opt-in.
    const s = await assistantSchedule("what needs me today?");

    expect(await scheduler.skipForIdle((await store.getSchedule(s.id))!)).toBe(false);
  });

  it("stops after the daily ceiling rather than answering a runaway cron", async () => {
    // Nothing else bounds these: a briefing holds no tmux and no working tree,
    // so a schedule set to "* * * * *" would quietly make 1440 model calls a
    // day against the subscription and no other guard would notice.
    const s = await assistantSchedule("what needs me today?");
    // A fresh module registry so the day's count starts at zero here, rather
    // than carrying whatever the tests above spent.
    vi.resetModules();
    const fresh = await import("../src/scheduler.js");

    // Sixty since triage joined the count: a busy day is twenty or thirty
    // small triage calls, and a backstop that bit on an ordinary day would be
    // a budget rather than a backstop.
    for (let i = 0; i < 60; i++) expect(await fresh.runSchedule(s.id, log)).not.toBeNull();
    const overflow = await fresh.runSchedule(s.id, log);

    expect(overflow).toBeNull();
    expect((await store.getSchedule(s.id))!.lastError).toContain("already ran today");
    expect(fake.argvFor("claude")).toHaveLength(60);
  });

  it("keeps its threads out of the ones recall searches", async () => {
    // A nightly briefing and a nightly harvest add some seven hundred threads a
    // year, all of them the machine talking to itself. Recall reads every file
    // in the directory on every call, so left together they would both drown
    // the results and make every search slower forever.
    const dir = process.env.ASSISTANT_DIR!;
    const threads = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith(".jsonl")).length;
    const s = await assistantSchedule("what needs me today?");
    const before = threads(path.join(dir, "unattended"));

    await scheduler.runSchedule(s.id, log);

    // Nothing at the top level, which is the only place `search` looks.
    expect(threads(dir)).toBe(0);
    expect(threads(path.join(dir, "unattended"))).toBe(before + 1);
  });

  it("records a failed turn as an error rather than as a report", async () => {
    fake.reply("claude", "-p", { stdout: "", code: 1, stderr: "not logged in" });
    const s = await assistantSchedule("what needs me today?");

    expect(await scheduler.runSchedule(s.id, log)).toBeNull();
    expect((await store.getSchedule(s.id))!.lastError).toBeTruthy();
    expect((await store.getSchedule(s.id))!.lastReport).toBeNull();
  });

  it("reads a turn that could not run as failed, not as a schedule holding off", async () => {
    // The one that cost five nights: a lapsed login made every assistant run
    // record an error, errors all read as "blocked", and blocked is the word
    // for a schedule deciding not to start — so the screen that says what
    // needs you showed the symptoms and never the cause.
    fake.reply("claude", "-p", {
      stdout: "",
      code: 1,
      stderr: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    const s = await assistantSchedule("what needs me today?");

    await scheduler.runSchedule(s.id, log);

    const run = (await store.listRuns()).find((r) => r.scheduleId === s.id)!;
    expect(run.outcome).toBe("failed");
    expect(run.error).toContain("OAuth session expired");
  });

  it("still reads a ceiling or an empty queue as the schedule holding off", async () => {
    const s = await schedule("check the open PRs");
    const first = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(first!.id) });

    await scheduler.runSchedule(s.id, log);

    const run = (await store.listRuns()).find((r) => r.scheduleId === s.id)!;
    expect(run.outcome).toBe("blocked");
    expect(run.error).toMatch(/still open/);
  });
});

describe("a run that could not run at all", () => {
  interface Push {
    body: string;
    headers: Record<string, string>;
  }

  /** Every ntfy push sent while the callback ran. */
  async function pushes(fn: () => Promise<unknown>): Promise<Push[]> {
    const sent: Push[] = [];
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const req = (init ?? {}) as { body?: string; headers?: Record<string, string> };
      sent.push({ body: req.body ?? "", headers: req.headers ?? {} });
      return new Response("", { status: 200 });
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return sent;
  }

  it("wakes someone the first time, since the thing that would say so is what died", async () => {
    // Triage is an assistant turn and the notifier watches sessions, so a
    // briefing that cannot authenticate has neither a judge nor a transition.
    // Nothing pushed for five nights. This is the push the scheduler sends.
    fake.reply("claude", "-p", {
      stdout: "",
      code: 1,
      stderr: "Failed to authenticate: OAuth session expired and could not be refreshed",
    });
    const s = await assistantSchedule("what needs me today?");

    const sent = await pushes(() => scheduler.runSchedule(s.id, log));

    expect(sent).toHaveLength(1);
    expect(sent[0].headers["X-Title"]).toBe("briefing could not run");
    expect(sent[0].body).toContain("OAuth session expired");
    expect(sent[0].headers["X-Priority"]).toBe("high");
  });

  it("says it once, not every night it stays broken", async () => {
    fake.reply("claude", "-p", { stdout: "", code: 1, stderr: "not logged in" });
    const s = await assistantSchedule("what needs me today?");

    const sent = await pushes(async () => {
      await scheduler.runSchedule(s.id, log);
      await scheduler.runSchedule(s.id, log);
      await scheduler.runSchedule(s.id, log);
    });

    // A standing fault belongs on Today with a count beside it, not on a phone
    // at 05:00 for the fourth morning running.
    expect(sent).toHaveLength(1);
  });

  it("says nothing when the schedule simply held off", async () => {
    const s = await schedule("render tonight's queue");
    const first = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(first!.id) });

    const sent = await pushes(() => scheduler.runSchedule(s.id, log));

    expect(sent).toEqual([]);
  });
});

describe("a scheduled session that has signed off", () => {
  /** The verdict the run wrote for itself, in the file the prompt names. */
  function signOff(id: string, line: string) {
    fs.writeFileSync(path.join(sessionsDir, `${id}.report`), `${line}\n`);
  }

  it("is ended, so the next night is not skipped for a run that finished at 02:00", async () => {
    const s = await schedule("render tonight's queue");
    const session = await sessionFrom(s.id);
    // A schedule's session runs the TUI: it writes its report and then sits at
    // the prompt, so tmux goes on listing it until somebody ends it.
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    signOff(session!.id, "ok: nothing to render");

    await scheduler.endSignedOffRuns(log);

    expect(fake.subcommand("tmux", "kill-session").map((a) => a.at(-1))).toContain(
      `=${session!.id}`,
    );
  });

  it("is left alone while it has written nothing, because it may be asking", async () => {
    const s = await schedule("render tonight's queue");
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });

    await scheduler.endSignedOffRuns(log);

    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
  });

  it("leaves an unattended run to the watch that knows when its agent exited", async () => {
    const s = await stageSchedule();
    const session = await sessionFrom(s.id);
    fake.reply("tmux", "ls", { stdout: tmuxLsRows(session!.id) });
    signOff(session!.id, "ok: nothing to scout");

    await scheduler.endSignedOffRuns(log);

    // Its agent has not exited yet; ending it here would cut a headless run
    // short and skip the worktree cleanup watchUnattended does after it.
    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
  });
});

describe("a tick the pod was down for", () => {
  afterEach(async () => {
    vi.useRealTimers();
    // Leave no timers behind for the next test to count, or for the process to
    // wait on before it can exit.
    for (const s of await store.listSchedules()) await store.deleteSchedule(s.id);
    await scheduler.reloadSchedules(log);
  });

  /** The stamp a pod that had been up for that tick would have left behind. */
  function firedAt(id: string, at: string) {
    const file = path.join(schedulesDir, `${id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...stored, lastFiredAt: at }));
  }

  /**
   * A catch-up is deliberately not awaited by the reload that starts it, so
   * every assertion here is about something that lands a moment later. Only the
   * Date is ever faked below, which leaves setTimeout real and a plain poll —
   * counted in tries, since a frozen clock would never reach a deadline.
   */
  async function eventually(done: () => boolean | Promise<boolean>, tries = 200) {
    for (let i = 0; i < tries && !(await done()); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it("runs the tick it was down for, on the way back up", async () => {
    // Pinned to a fixed instant so this reads the rule and not the clock: a
    // half-hourly schedule last fired at 09:05, back up at 09:35. The 09:30
    // tick is five minutes old, well inside the window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-06-01T09:35:00Z"));
    const s = await store.createSchedule({
      name: "nightly",
      project: "demo",
      cron: "*/30 * * * *",
      prompt: "check the open PRs",
    });
    firedAt(s.id, "2026-06-01T09:05:00Z");

    await scheduler.reloadSchedules(log);
    await eventually(() => fake.subcommand("tmux", "new-session").length > 0);

    expect(fake.subcommand("tmux", "new-session")).toHaveLength(1);
    // And the tick is accounted for, so the next boot does not run it again.
    expect((await store.getSchedule(s.id))!.lastFiredAt).toBe("2026-06-01T09:35:00.000Z");
  });

  it("records one it is too late for rather than letting it vanish", async () => {
    // The whole point: a run that reports itself ok is meant to leave the inbox
    // quiet, so a scheduler that never fired must not read like a quiet night.
    const s = await schedule("check the open PRs");
    firedAt(s.id, "2020-01-01T00:00:00Z");

    await scheduler.reloadSchedules(log);
    await eventually(async () => (await store.getSchedule(s.id))!.lastError !== null);

    const after = (await store.getSchedule(s.id))!;
    expect(after.lastError).toContain("missed while the pod was down");
    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
    // Stamped too, or a pod that keeps restarting reports the same missed tick
    // every boot until it has pushed the real history out of the run list.
    expect(after.lastFiredAt).not.toBe("2020-01-01T00:00:00Z");
  });

  it("leaves alone a schedule that has never fired", async () => {
    // A schedule added moments ago — and, the first time this ships, every
    // schedule there is. Nothing to compare against is not a missed tick.
    const s = await schedule("check the open PRs");

    await scheduler.reloadSchedules(log);
    await eventually(() => fake.subcommand("tmux", "new-session").length > 0, 20);

    expect(fake.subcommand("tmux", "new-session")).toEqual([]);
    const after = (await store.getSchedule(s.id))!;
    expect(after.lastError).toBeNull();
    expect(after.lastFiredAt).toBeNull();
  });
});

describe("missedTick", () => {
  // Fixed dates, all of them long before this process started, which is half of
  // what "missed" means. `due` is the first occurrence after the schedule last
  // fired; `after` the one following it, which carries the interval.
  const due = new Date("2026-01-01T07:00:00Z");
  const tomorrow = new Date("2026-01-02T07:00:00Z");
  const fired = "2026-01-01T06:00:00Z";
  const at = due.getTime();

  it("catches up on a tick that is minutes old", () => {
    expect(scheduler.missedTick(fired, due, tomorrow, at + 20 * 60_000)).toBe("catch up");
  });

  it("gives up on one whose moment has passed", () => {
    // A 07:00 briefing read at lunchtime is yesterday's news.
    expect(scheduler.missedTick(fired, due, tomorrow, at + 5 * 3_600_000)).toBe("too late");
  });

  it("waits for the next tick rather than firing one just ahead of it", () => {
    // Hourly, fifty minutes late: catching up would run ten minutes before the
    // tick it was about to get anyway.
    const nextHour = new Date(at + 3_600_000);
    expect(scheduler.missedTick(fired, due, nextHour, at + 50 * 60_000)).toBe("too late");
  });

  it("has nothing to go on for a schedule that has never fired", () => {
    expect(scheduler.missedTick(null, due, tomorrow, at + 60_000)).toBe("nothing");
  });

  it("leaves alone a tick this process was up for", () => {
    // Not missed for want of a pod: croner's protect dropped it because the
    // previous run — or its jitter — was still going, and that is deliberate.
    const up = new Date();
    const next = new Date(up.getTime() + 3_600_000);
    expect(scheduler.missedTick(fired, up, next, up.getTime() + 60_000)).toBe("nothing");
  });
});

describe("reloadSchedules", () => {
  // Leave no timers behind for the next test to count.
  afterEach(async () => {
    for (const s of await store.listSchedules()) await store.deleteSchedule(s.id);
    await scheduler.reloadSchedules(log);
  });

  it("leaves one timer per schedule, and no casualties, when two reloads overlap", async () => {
    // A rebuild clears its map before an await and refills it after, so two
    // overlapping calls both clear before either fills. The second one then
    // tries to build timers the first has already built, croner refuses the
    // duplicate names, and the rebuild swallows the refusals as unusable
    // patterns — leaving the schedules running on the timers the *first* call
    // built, which is the state the second call was reloading to replace.
    await schedule("check the open PRs");
    await schedule("check the failing runs");
    const warnings: (string | undefined)[] = [];
    const noisy = { info: () => {}, warn: (_err: unknown, msg?: string) => warnings.push(msg) };

    await Promise.all([scheduler.reloadSchedules(noisy), scheduler.reloadSchedules(noisy)]);

    expect(scheduledJobs).toHaveLength(2);
    expect(warnings).toEqual([]);
  });
});
