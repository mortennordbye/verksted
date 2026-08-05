import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TmuxUnavailableError } from "../src/tmux.js";

// sessions-store is the state machine; everything it talks to is stubbed so the
// tests are about its own decisions rather than tmux, git or chromium.
const tmuxList = vi.fn<() => Promise<string[]>>();
const tmuxNew = vi.fn<() => Promise<void>>();
const tmuxKill = vi.fn<(name: string) => Promise<void>>();

vi.mock("../src/tmux.js", async () => {
  const actual = await vi.importActual<typeof import("../src/tmux.js")>("../src/tmux.js");
  return {
    ...actual,
    listSessions: () => tmuxList(),
    newSession: () => tmuxNew(),
    killSession: (name: string) => tmuxKill(name),
  };
});

vi.mock("../src/browser.js", () => ({
  nextCdpPort: (used: Set<number>) => 9222 + used.size,
  closeBrowser: async () => {},
}));

vi.mock("../src/git.js", () => ({
  syncDefaultBranch: async () => ({ branch: "main", status: "skipped", detail: "test" }),
}));

vi.mock("../src/claude-hooks.js", () => ({
  ensureHooksSettings: async () => "/tmp/hooks.json",
  ensureMcpConfig: async () => "/tmp/mcp.json",
}));

let store: typeof import("../src/sessions-store.js");
let sessionsDir: string;
let reposDir: string;

const metaFile = (id: string) => path.join(sessionsDir, `${id}.json`);
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
  for (const f of fs.readdirSync(sessionsDir)) fs.rmSync(path.join(sessionsDir, f));
});

/**
 * The bug this guards: tmux.listSessions used to swallow every failure and
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
    expect(session!.status).toBe("running");
    expect(session!.endedAt).toBeNull();
    expect(readMetaFile("vk-demo-1").endedAt).toBeNull();
    expect(fs.statSync(metaFile("vk-demo-1")).mtimeMs).toBe(before);
  });

  it("keeps reporting an already-ended session as done", async () => {
    writeMeta("vk-demo-2", { endedAt: "2026-01-02T00:00:00.000Z" });
    const [session] = await store.listSessions();
    expect(session!.status).toBe("done");
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
    expect(first!.status).toBe("done");
    const endedAt = readMetaFile("vk-demo-1").endedAt;
    expect(endedAt).not.toBeNull();

    const [second] = await store.listSessions();
    expect(second!.endedAt).toBe(endedAt);
  });

  it("reports a session tmux still has as running", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue(["vk-demo-1"]);
    expect((await store.listSessions())[0]!.status).toBe("running");
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
    fs.writeFileSync(metaFile("vk-demo-2"), JSON.stringify({
      id: "vk-demo-2", project: "demo", agent: "claude", title: bigTitle,
      createdAt: "2026-01-01T00:00:00.000Z", endedAt: null,
    }));

    const reads = await Promise.all(
      Array.from({ length: 20 }, () => store.listSessions()),
    );
    for (const list of reads) expect(list).toHaveLength(2);
  });

  it("leaves no temp files behind", async () => {
    writeMeta("vk-demo-1");
    tmuxList.mockResolvedValue([]);
    await store.listSessions();
    expect(fs.readdirSync(sessionsDir).filter((f) => f.endsWith(".tmp"))).toHaveLength(0);
  });
});
