import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scheduledJobs } from "croner";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeBin } from "./helpers/fake-bin.js";

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

async function schedule(prompt: string, project = "demo") {
  return store.createSchedule({ name: "nightly", project, cron: CRON, prompt });
}

/** The -e KEY=VALUE pairs a tmux new-session call carried. */
function envOf(argv: string[]): Record<string, string> {
  return Object.fromEntries(
    argv.flatMap((a, i) => (a === "-e" ? [argv[i + 1].split(/=(.*)/s) as [string, string]] : [])),
  );
}

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  const dir = path.join(reposDir, "demo");
  execFileSync("git", ["init", "-b", "main", dir], { stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.txt"), "hello");
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
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = schedulesDir;
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
});

describe("runSchedule", () => {
  it("starts a claude session in the schedule's project", async () => {
    const s = await schedule("check the open PRs");

    const session = await scheduler.runSchedule(s.id, log);

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
  });

  it("runs unattended in auto permission mode", async () => {
    // Nobody is there at 07:00 to answer a permission prompt.
    const s = await schedule("check the open PRs");

    await scheduler.runSchedule(s.id, log);

    expect(fake.subcommand("tmux", "new-session")[0].at(-1)).toContain("--permission-mode auto");
  });

  it("skips a tick while the previous run is still open, and records why", async () => {
    const s = await schedule("check the open PRs");
    const first = await scheduler.runSchedule(s.id, log);
    // The session the first run started is still live on the tmux server.
    fake.reply("tmux", "ls", { stdout: `${first!.id}\n` });
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
