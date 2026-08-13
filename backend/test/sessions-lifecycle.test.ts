import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxUnavailableError } from "../src/tmux.js";
import type { SessionWork } from "../../shared/api.js";

// sessions-store is the state machine; everything it talks to is stubbed so the
// tests are about its own decisions rather than tmux, git or chromium.
const tmuxList = vi.fn<() => Promise<string[]>>();
const tmuxNew = vi.fn<(...args: unknown[]) => Promise<void>>();
const tmuxKill = vi.fn<(name: string) => Promise<void>>();

/**
 * The store asks tmux for detail, not just names. Every case here that only
 * cares about which sessions are live keeps saying so through tmuxList, and
 * this derives a plausible detail row from it: active this second, and a pane
 * pid that resolves to a process with children (pid 1 always has some), which
 * is what the sweep reads as "the agent is still there".
 */
const tmuxDetail = vi.fn(async () =>
  (await tmuxList()).map((name) => ({
    name,
    activity: Math.floor(Date.now() / 1000),
    panePid: 1,
  })),
);

vi.mock("../src/tmux.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tmux.js")>("../src/tmux.js");
  return {
    ...actual,
    listSessionsDetail: () => tmuxDetail(),
    newSession: (...args: unknown[]) => tmuxNew(...args),
    killSession: (name: string) => tmuxKill(name),
  };
});

vi.mock("../src/browser.js", () => ({
  nextCdpPort: (used: Set<number>) => 9222 + used.size,
  closeBrowser: async () => {},
}));

const gitHead = vi.fn<() => Promise<string | null>>();
const gitWork = vi.fn<(...args: unknown[]) => Promise<SessionWork | null>>();

vi.mock("../src/git.js", () => ({
  syncDefaultBranch: async () => ({ branch: "main", status: "skipped", detail: "test" }),
  headCommit: () => gitHead(),
  workSince: (...args: unknown[]) => gitWork(...args),
}));

const WORK: SessionWork = { commits: 2, files: 3, dirty: 1, unpushed: 2, branch: "main" };

vi.mock("../src/claude-hooks.js", () => ({
  ensureHooksSettings: async () => "/tmp/hooks.json",
  ensureMcpConfig: async () => "/tmp/mcp.json",
}));

let store: typeof import("../src/sessions-store.js");
let sessionsDir: string;
let reposDir: string;

const metaFile = (id: string) => path.join(sessionsDir, `${id}.json`);

/** The extraEnv the last newSession call was given (its 4th argument). */
const tmuxNewEnv = (): Record<string, string> =>
  (tmuxNew.mock.calls.at(-1)?.[3] ?? {}) as Record<string, string>;
const readMetaFile = (id: string) => JSON.parse(fs.readFileSync(metaFile(id), "utf8"));

function writeMeta(id: string, extra: Record<string, unknown> = {}) {
  fs.writeFileSync(
    metaFile(id),
    JSON.stringify({
      id,
      project: "demo",
      agent: "claude",
      title: "t",
      createdAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      ...extra,
    }),
  );
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  store = await import("../src/sessions-store.js");
});

beforeEach(() => {
  vi.clearAllMocks();
  tmuxNew.mockResolvedValue(undefined);
  tmuxKill.mockResolvedValue(undefined);
  gitHead.mockResolvedValue("start0");
  gitWork.mockResolvedValue(WORK);
  for (const f of fs.readdirSync(sessionsDir)) fs.rmSync(path.join(sessionsDir, f));
});

/**
 * The bug this guards: the tmux listing used to swallow every failure and
 * return [], so one bad `tmux ls` marked every session done, wrote endedAt to
 * each, and made the notifier push "finished" per session — every 5 s.
 */
describe("liveness when tmux cannot be asked", () => {
  beforeEach(() => {
    tmuxList.mockRejectedValue(new TmuxUnavailableError(new Error("fork failed")));
  });

  it("does not end a live session, and does not write to it", async () => {
    writeMeta("vk-demo-1");
    const before = fs.statSync(metaFile("vk-demo-1")).mtimeMs;

    const [session] = await store.listSessions();
    expect(session.status).toBe("running");
    expect(session.endedAt).toBeNull();
    expect(readMetaFile("vk-demo-1").endedAt).toBeNull();
    expect(fs.statSync(metaFile("vk-demo-1")).mtimeMs).toBe(before);
  });

  it("keeps reporting an already-ended session as done", async () => {
    writeMeta("vk-demo-2", { endedAt: "2026-01-02T00:00:00.000Z" });
    const [session] = await store.listSessions();
    expect(session.status).toBe("done");
  });

  it("applies the same fallback to a single get", async () => {
    writeMeta("vk-demo-3");
    expect((await store.getSession("vk-demo-3"))!.status).toBe("running");
  });

  it("kills nothing while it cannot tell what is alive", async () => {
    writeMeta("vk-demo-4");
    await store.listSessions();
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it("skips restore rather than starting a second agent for each session", async () => {
    writeMeta("vk-demo-5");
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-5.conv"), "4b953f35-5791-4984-93a4-cfea9871");
    const warn = vi.fn();
    await store.restoreSessions({ info: vi.fn(), warn });
    expect(tmuxNew).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});

describe("liveness when tmux answers", () => {
  it("stamps a session whose tmux is gone, once", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue([]);

    const [first] = await store.listSessions();
    expect(first.status).toBe("done");
    const endedAt = readMetaFile("vk-demo-1").endedAt;
    expect(endedAt).not.toBeNull();

    const [second] = await store.listSessions();
    expect(second.endedAt).toBe(endedAt);
  });

  it("reports a session tmux still has as running", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue(["vk-demo-1"]);
    expect((await store.listSessions())[0].status).toBe("running");
  });

  it("measures what the repo has to show for the session, when it is first seen done", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    tmuxList.mockResolvedValue([]);

    const [first] = await store.listSessions();

    expect(first.work).toEqual(WORK);
    expect(gitWork).toHaveBeenCalledWith(expect.stringContaining("demo"), "start0");
    // Measured on the way out and then kept, not recomputed per read: the repo
    // keeps moving, and the next session's commits must not join this row.
    gitWork.mockResolvedValue({ ...WORK, commits: 99 });
    expect((await store.listSessions())[0].work).toEqual(WORK);
    expect(gitWork).toHaveBeenCalledTimes(1);
  });

  it("has nothing to measure for a session that started outside a repo", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue([]);

    expect((await store.listSessions())[0].work).toBeNull();
    expect(gitWork).not.toHaveBeenCalled();
  });

  it("claims nothing about a session that is still running", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    tmuxList.mockResolvedValue(["vk-demo-1"]);

    expect((await store.listSessions())[0].work).toBeNull();
  });

  it("reaps a shell companion left behind by a dead agent session", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue(["vk-demo-1-shell"]);
    await store.listSessions();
    expect(tmuxKill).toHaveBeenCalledWith("vk-demo-1-shell");
  });
});

describe("createSession", () => {
  beforeEach(() => tmuxList.mockResolvedValue([]));

  // Two concurrent creates used to read the same highest seq and mint the same
  // id: the second tmux new-session failed and the metadata was clobbered.
  it("gives concurrent creates distinct ids", async () => {
    const made = await Promise.all(
      Array.from({ length: 5 }, () =>
        store.createSession("demo", path.join(reposDir, "demo"), "claude"),
      ),
    );
    const ids = made.map((s) => s.id);
    expect(new Set(ids).size).toBe(5);
    expect([...ids].sort()).toEqual(
      ["vk-demo-1", "vk-demo-2", "vk-demo-3", "vk-demo-4", "vk-demo-5"].sort(),
    );
    // And each one is on disk, rather than the last writer winning.
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))).toHaveLength(5);
  });

  it("records where the repo was, as the stick to measure the session against", async () => {
    const session = await store.createSession("demo", path.join(reposDir, "demo"), "claude");

    expect(readMetaFile(session.id).startCommit).toBe("start0");
    // A measuring stick, not something any screen shows.
    expect(session).not.toHaveProperty("startCommit");
    expect(session.work).toBeNull();
  });

  it("reserves a distinct cdp port per session", async () => {
    await store.createSession("demo", path.join(reposDir, "demo"), "claude");
    await store.createSession("demo", path.join(reposDir, "demo"), "claude");
    const ports = ["vk-demo-1", "vk-demo-2"].map((id) => readMetaFile(id).cdpPort);
    expect(new Set(ports).size).toBe(2);
  });

  // A tmux session with no metadata is invisible in the UI and never reaped —
  // only kubectl exec would find it.
  it("leaves no metadata behind when the agent fails to start", async () => {
    tmuxNew.mockRejectedValue(new Error("tmux: command not found"));
    await expect(
      store.createSession("demo", path.join(reposDir, "demo"), "claude"),
    ).rejects.toThrow();
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))).toHaveLength(0);
  });

  it("keeps allocating ids after a failed create", async () => {
    tmuxNew.mockRejectedValueOnce(new Error("boom"));
    await expect(
      store.createSession("demo", path.join(reposDir, "demo"), "claude"),
    ).rejects.toThrow();
    const ok = await store.createSession("demo", path.join(reposDir, "demo"), "claude");
    expect(ok.id).toBe("vk-demo-1");
  });
});

describe("endSession", () => {
  beforeEach(() => tmuxList.mockResolvedValue(["vk-demo-1"]));

  // endSession rebuilt Meta from Session, which has cdpPort stripped, so every
  // end leaked the reserved port until the pool ran out and threw a bare 500.
  it("keeps the reserved cdp port", async () => {
    writeMeta("vk-demo-1", { cdpPort: 9231 });
    await store.endSession("vk-demo-1");
    expect(readMetaFile("vk-demo-1").cdpPort).toBe(9231);
  });

  it("stamps endedAt and reports the session done", async () => {
    writeMeta("vk-demo-1", { cdpPort: 9231 });
    const ended = await store.endSession("vk-demo-1");
    expect(ended!.status).toBe("done");
    expect(readMetaFile("vk-demo-1").endedAt).not.toBeNull();
  });

  it("measures the work when it is a DELETE that ends the session", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });

    const ended = await store.endSession("vk-demo-1");

    expect(ended!.work).toEqual(WORK);
    expect(readMetaFile("vk-demo-1").work).toEqual(WORK);
  });

  it("keeps the measurement the sweep already took", async () => {
    // Ending an ended session must not re-measure it against a repo that has
    // moved on since.
    writeMeta("vk-demo-1", { endedAt: "2026-01-02T00:00:00.000Z", work: WORK });

    await store.endSession("vk-demo-1");

    expect(gitWork).not.toHaveBeenCalled();
    expect(readMetaFile("vk-demo-1").work).toEqual(WORK);
  });

  it("succeeds even when the tmux kill fails", async () => {
    writeMeta("vk-demo-1");
    tmuxKill.mockRejectedValue(new Error("no such session"));
    expect((await store.endSession("vk-demo-1"))!.status).toBe("done");
  });

  it("is null for an unknown session", async () => {
    expect(await store.endSession("vk-ghost-9")).toBeNull();
  });
});

describe("metadata writes", () => {
  it("never leaves a reader a half-written file", async () => {
    // Interleaved writers on the same id: with a plain writeFile one reader
    // catches a truncated file, readAll skips it, and the session vanishes.
    writeMeta("vk-demo-1", { cdpPort: 9222 });
    tmuxList.mockResolvedValue([]);
    const bigTitle = "x".repeat(60_000);
    fs.writeFileSync(
      metaFile("vk-demo-2"),
      JSON.stringify({
        id: "vk-demo-2",
        project: "demo",
        agent: "claude",
        title: bigTitle,
        createdAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
      }),
    );

    const reads = await Promise.all(Array.from({ length: 20 }, () => store.listSessions()));
    for (const list of reads) expect(list).toHaveLength(2);
  });

  it("leaves no temp files behind", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue([]);
    await store.listSessions();
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});

// The verdict an agent writes about its own work. VK_REPORT_FILE was always set
// for every session, but only scheduled runs had their report read — so an
// interactive session that wrote one had it ignored.
describe("session sign-off", () => {
  beforeEach(() => tmuxList.mockResolvedValue(["vk-demo-1"]));

  const writeReport = (id: string, text: string) =>
    fs.writeFileSync(path.join(sessionsDir, `${id}.report`), text);

  it("carries the report and its outcome on any session", async () => {
    writeMeta("vk-demo-1");
    writeReport("vk-demo-1", "attention: the migration needs a decision\nsecond line");
    const [session] = await store.listSessions();
    expect(session.report).toBe("attention: the migration needs a decision");
    expect(session.outcome).toBe("attention");
  });

  it("classifies each verdict, case-insensitively", async () => {
    for (const [text, expected] of [
      ["ok: nothing to do", "ok"],
      ["OK: shouty but fine", "ok"],
      ["failed: could not build", "failed"],
      ["Attention: needs you", "attention"],
    ] as const) {
      writeMeta("vk-demo-1");
      writeReport("vk-demo-1", text);
      const [session] = await store.listSessions();
      expect(session.outcome, text).toBe(expected);
    }
  });

  it("falls back to where the session got to when nothing was written", async () => {
    writeMeta("vk-demo-1");
    const [live] = await store.listSessions();
    expect(live.report).toBeNull();
    expect(live.outcome).toBe("running");

    tmuxList.mockResolvedValue([]);
    const [dead] = await store.listSessions();
    expect(dead.outcome).toBe("done");
  });

  it("ignores an unparseable verdict rather than guessing", async () => {
    writeMeta("vk-demo-1");
    writeReport("vk-demo-1", "I did some things");
    const [session] = await store.listSessions();
    expect(session.report).toBe("I did some things");
    expect(session.outcome).toBe("running");
  });
});

// Standing context: the hub stops being stateless. Conventions and decisions
// were re-explained to every agent otherwise, and on a phone the re-typing is
// the expensive part.
describe("per-project standing context", () => {
  beforeEach(() => tmuxList.mockResolvedValue([]));

  const writeContext = (text: string) => {
    const dir = path.join(reposDir, "demo", ".verksted");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "context.md"), text);
  };

  const clearContext = () =>
    fs.rmSync(path.join(reposDir, "demo", ".verksted"), { recursive: true, force: true });

  it("prepends the context to a session's prompt", async () => {
    writeContext("Always run make lint before committing.");
    await store.createSession("demo", path.join(reposDir, "demo"), "claude", {
      prompt: "tidy the imports",
    });
    const env = tmuxNewEnv();
    expect(env.VK_PROMPT).toBe(
      "Always run make lint before committing.\n\n---\n\ntidy the imports",
    );
    clearContext();
  });

  it("leaves the prompt alone when there is no context file", async () => {
    clearContext();
    await store.createSession("demo", path.join(reposDir, "demo"), "claude", {
      prompt: "tidy the imports",
    });
    expect(tmuxNewEnv().VK_PROMPT).toBe("tidy the imports");
  });

  it("ignores a context file that is only whitespace", async () => {
    writeContext("   \n\n  ");
    await store.createSession("demo", path.join(reposDir, "demo"), "claude", { prompt: "go" });
    expect(tmuxNewEnv().VK_PROMPT).toBe("go");
    clearContext();
  });

  it("caps a context file that someone pasted a whole document into", async () => {
    writeContext("x".repeat(20_000));
    await store.createSession("demo", path.join(reposDir, "demo"), "claude", { prompt: "go" });
    expect(tmuxNewEnv().VK_PROMPT.length).toBeLessThan(8_100);
    clearContext();
  });
});

/**
 * The sweep that ends sessions whose agent has exited, leaving the pane at a
 * shell. Its whole safety rests on one kernel fact — that a live agent shows up
 * as a child of the pane process — so these use real processes rather than a
 * stub of the check: a kernel without /proc children support has to fail here
 * and not in the pod, where the cost is an ended session.
 */
describe("reapFinishedSessions", () => {
  const spawned: ChildProcess[] = [];
  const log = { info: vi.fn(), warn: vi.fn() };

  /** A pane whose agent has exited: a process with no children. */
  const bareShell = (): number => {
    const p = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(p);
    return p.pid!;
  };

  /** A pane still running its agent: a shell with a child under it. */
  const withAgent = async (): Promise<number> => {
    const p = spawn("sh", ["-c", "sleep 30 & wait"], { stdio: "ignore" });
    spawned.push(p);
    // The child appears a moment after the shell does.
    for (let i = 0; i < 50; i++) {
      const kids = fs.readFileSync(`/proc/${p.pid}/task/${p.pid}/children`, "utf8").trim();
      if (kids) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return p.pid!;
  };

  /** One live session, idle for `idleMinutes`, with the given pane process. */
  const live = (id: string, panePid: number, idleMinutes: number) =>
    tmuxDetail.mockResolvedValue([
      { name: id, activity: Math.floor(Date.now() / 1000) - idleMinutes * 60, panePid },
    ]);

  afterEach(() => {
    for (const p of spawned.splice(0)) p.kill("SIGKILL");
    tmuxDetail.mockReset();
  });

  it("ends a session whose agent exited and left nothing behind", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 0, unpushed: 0 });
    live("vk-demo-1", bareShell(), 180);

    expect(await store.reapFinishedSessions(log)).toEqual(["vk-demo-1"]);
    expect(tmuxKill).toHaveBeenCalledWith("vk-demo-1");
    // Ended, not deleted: the report and the range it left are the history.
    expect(readMetaFile("vk-demo-1").endedAt).not.toBeNull();
    expect(fs.existsSync(metaFile("vk-demo-1"))).toBe(true);
  });

  it("leaves a session whose agent is still running, however quiet it has been", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 0, unpushed: 0 });
    live("vk-demo-1", await withAgent(), 24 * 60);

    expect(await store.reapFinishedSessions(log)).toEqual([]);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  it("leaves a session that has not been idle long enough", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 0, unpushed: 0 });
    live("vk-demo-1", bareShell(), 5);

    expect(await store.reapFinishedSessions(log)).toEqual([]);
  });

  /** A question addressed to a person is the inbox's business, not a sweep's. */
  it("leaves a session that is waiting on an answer", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 0, unpushed: 0 });
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-1.state"), "waiting");
    live("vk-demo-1", bareShell(), 180);

    expect(await store.reapFinishedSessions(log)).toEqual([]);
    expect(tmuxKill).not.toHaveBeenCalled();
  });

  /** The volume is the only copy of anything git has not been told about. */
  it("leaves a session holding uncommitted work, and says so", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 3, unpushed: 0 });
    live("vk-demo-1", bareShell(), 180);

    expect(await store.reapFinishedSessions(log)).toEqual([]);
    expect(readMetaFile("vk-demo-1").endedAt).toBeNull();
    expect(log.warn).toHaveBeenCalled();
  });

  it("leaves a session whose commits have not reached a remote", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    gitWork.mockResolvedValue({ ...WORK, dirty: 0, unpushed: 2 });
    live("vk-demo-1", bareShell(), 180);

    expect(await store.reapFinishedSessions(log)).toEqual([]);
  });

  it("sweeps nothing while tmux cannot be asked", async () => {
    writeMeta("vk-demo-1", { startCommit: "start0" });
    tmuxDetail.mockRejectedValue(new TmuxUnavailableError(new Error("fork failed")));

    expect(await store.reapFinishedSessions(log)).toEqual([]);
    expect(tmuxKill).not.toHaveBeenCalled();
  });
});
