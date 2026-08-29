import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../../shared/api.js";

/**
 * Tokens are the one number that says what the bench is costing against the
 * subscription's allowance, and the transcript is the only place they are
 * written. Getting the sum wrong by a factor of blocks-per-message, which is
 * what a naive line count does, would make every session look three times
 * its size.
 */
let usage: typeof import("../src/usage.js");
let store: typeof import("../src/sessions-store.js");
let home: string;
let reposDir: string;
let sessionsDir: string;

const CONV = "3c4cde47-7829-4754-add9-ad19f99b80a3";

/** One assistant entry as claude writes it: usage on every block of a message. */
function assistant(
  id: string,
  u: { input?: number; output?: number; read?: number; write?: number },
): string {
  return JSON.stringify({
    type: "assistant",
    requestId: `req_${id}`,
    message: {
      id: `msg_${id}`,
      role: "assistant",
      model: "claude-fable-5",
      usage: {
        input_tokens: u.input ?? 0,
        output_tokens: u.output ?? 0,
        cache_read_input_tokens: u.read ?? 0,
        cache_creation_input_tokens: u.write ?? 0,
      },
    },
  });
}

function projectDir(project: string): string {
  return path.join(home, ".claude", "projects", `${reposDir}/${project}`.replace(/\//g, "-"));
}

function writeTranscript(project: string, lines: string[], conv = CONV): void {
  fs.mkdirSync(projectDir(project), { recursive: true });
  fs.writeFileSync(path.join(projectDir(project), `${conv}.jsonl`), lines.join("\n") + "\n");
}

function session(over: Partial<Session>): Session {
  return {
    id: "vk-demo-1",
    project: "demo",
    agent: "claude",
    title: "x",
    createdAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T01:00:00.000Z",
    status: "done",
    report: null,
    outcome: "done",
    work: null,
    usage: null,
    review: { reviewed: 0, verdict: null },
    unattended: null,
    ...over,
  };
}

beforeAll(async () => {
  reposDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-")));
  fs.mkdirSync(path.join(reposDir, "demo"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  home = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.HOME = home;
  process.env.STATIC_DIR = "";
  usage = await import("../src/usage.js");
  store = await import("../src/sessions-store.js");
});

beforeEach(() => {
  for (const f of fs.readdirSync(sessionsDir)) fs.rmSync(path.join(sessionsDir, f));
  fs.rmSync(path.join(home, ".claude"), { recursive: true, force: true });
});

describe("usageOf", () => {
  it("sums each API message once, however many blocks it was written as", async () => {
    writeTranscript("demo", [
      JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
      // One response, a text block and a tool_use block: two lines, one usage.
      assistant("a", { input: 10, output: 100, read: 1000, write: 200 }),
      assistant("a", { input: 10, output: 100, read: 1000, write: 200 }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "tool_result" }] },
      }),
      assistant("b", { input: 5, output: 50, read: 1500 }),
      "not json at all",
    ]);

    const u = await usage.usageOf(path.join(reposDir, "demo"), CONV);
    expect(u).toMatchObject({ input: 15, output: 150, cacheRead: 2500, cacheWrite: 200, turns: 2 });
    // At Fable's list price: 15 in, 200 written at 1.25×, 2500 read at 0.1×, 150 out.
    expect(u!.costUsd).toBeCloseTo((15 * 10 + 200 * 12.5 + 2500 * 1 + 150 * 50) / 1e6, 8);
  });

  it("counts a subagent's conversation with its parent's", async () => {
    writeTranscript("demo", [assistant("a", { output: 10 })]);
    const sub = path.join(projectDir("demo"), CONV, "subagents");
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(
      path.join(sub, "agent-1.jsonl"),
      assistant("s", { output: 7, read: 300 }) + "\n",
    );

    const u = await usage.usageOf(path.join(reposDir, "demo"), CONV);
    expect(u).toMatchObject({ output: 17, cacheRead: 300, turns: 2 });
  });

  it("is null when there is no transcript, and zero when it has no answers", async () => {
    expect(await usage.usageOf(path.join(reposDir, "demo"), CONV)).toBeNull();
    writeTranscript("demo", [JSON.stringify({ type: "user", message: { content: "hi" } })]);
    expect(await usage.usageOf(path.join(reposDir, "demo"), CONV)).toMatchObject({ turns: 0 });
  });
});

describe("summarize", () => {
  const now = Date.parse("2026-08-29T12:00:00.000Z");
  const day = 24 * 60 * 60_000;
  const u = (n: number) => ({ input: n, output: 0, cacheRead: 0, cacheWrite: 0, turns: 1 });

  it("puts a session in every window its end falls inside", () => {
    const out = usage.summarize(
      [
        session({
          id: "vk-a-1",
          project: "a",
          endedAt: new Date(now - day / 2).toISOString(),
          usage: u(100),
        }),
        session({
          id: "vk-a-2",
          project: "a",
          endedAt: new Date(now - 3 * day).toISOString(),
          usage: u(1000),
        }),
        session({
          id: "vk-b-1",
          project: "b",
          endedAt: new Date(now - 20 * day).toISOString(),
          usage: u(10_000),
          unattended: "scout",
        }),
        session({
          id: "vk-b-2",
          project: "b",
          endedAt: new Date(now - 40 * day).toISOString(),
          usage: u(100_000),
        }),
        // Still running: nothing measured yet, so nothing to count.
        session({ id: "vk-c-1", project: "c", endedAt: null, status: "running", usage: null }),
      ],
      now,
    );
    expect(out.windows.map((w) => [w.label, w.tokens.input, w.sessions, w.unattended])).toEqual([
      ["24 hours", 100, 1, 0],
      ["7 days", 1100, 2, 0],
      ["30 days", 11_100, 3, 10_000],
      ["all time", 111_100, 4, 10_000],
    ]);
    // Every month from the first session's to this one, the empty one included.
    expect(out.months.map((m) => [m.month, m.total])).toEqual([
      ["2026-07", 100_000],
      ["2026-08", 11_100],
    ]);
    expect(out.projects).toEqual([
      { project: "b", total: 10_000, sessions: 1, costUsd: 0 },
      { project: "a", total: 1100, sessions: 2, costUsd: 0 },
    ]);
  });

  it("gives every one of the last thirty days a bar, zero or not", () => {
    const { days } = usage.summarize(
      [
        session({
          id: "vk-a-1",
          project: "a",
          endedAt: new Date(now - day).toISOString(),
          usage: u(500),
        }),
        session({
          id: "vk-a-2",
          project: "a",
          endedAt: new Date(now - day).toISOString(),
          usage: u(200),
          unattended: "scout",
        }),
      ],
      now,
    );
    expect(days).toHaveLength(30);
    expect(days.at(-1)!.date).toBe("2026-08-29");
    expect(days.at(-2)).toEqual({ date: "2026-08-28", total: 700, unattended: 200, costUsd: 0 });
    expect(days[0]).toEqual({ date: "2026-07-31", total: 0, unattended: 0, costUsd: 0 });
  });

  it("prices each model at its own list price, and a stranger by its family", () => {
    const one = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
    expect(usage.priceOf("claude-fable-5", one)).toBe(10);
    expect(usage.priceOf("claude-opus-4-8", one)).toBe(5);
    expect(usage.priceOf("claude-sonnet-5", one)).toBe(2);
    expect(usage.priceOf("claude-sonnet-4-6", one)).toBe(3);
    expect(usage.priceOf("claude-haiku-4-5-20251001", one)).toBe(1);
    expect(usage.priceOf("claude-opus-9", one)).toBe(5);
    expect(usage.priceOf(undefined, one)).toBe(5);
    expect(usage.priceOf("claude-sonnet-5", { ...one, input: 0, output: 1_000_000 })).toBe(10);
  });

  it("adds up the month's costs and counts how the sessions went", () => {
    const out = usage.summarize(
      [
        session({
          id: "vk-a-1",
          project: "a",
          endedAt: new Date(now - day).toISOString(),
          usage: { ...u(100), costUsd: 1.5 },
          outcome: "ok",
        }),
        session({
          id: "vk-a-2",
          project: "a",
          endedAt: new Date(now - 2 * day).toISOString(),
          usage: { ...u(100), costUsd: 0.25 },
          outcome: "failed",
        }),
        // Ended but never measured: still counted as a session that went somewhere.
        session({
          id: "vk-a-3",
          project: "a",
          endedAt: new Date(now - day).toISOString(),
          usage: null,
        }),
        session({
          id: "vk-a-4",
          project: "a",
          endedAt: new Date(now - 40 * day).toISOString(),
          usage: u(1),
          outcome: "ok",
        }),
      ],
      now,
    );
    expect(out.windows.map((w) => w.costUsd)).toEqual([1.5, 1.75, 1.75, 1.75]);
    expect(out.projects[0]).toMatchObject({ project: "a", costUsd: 1.75 });
    expect(out.days.at(-2)!.costUsd).toBe(1.5);
    expect(out.outcomes).toEqual({ ok: 1, attention: 0, failed: 1, done: 1 });
  });

  it("has no months when nothing was ever measured", () => {
    expect(usage.summarize([], now).months).toEqual([]);
  });

  it("carries the plan through untouched, null included", () => {
    expect(usage.summarize([], now).plan).toBeNull();
    const plan = {
      session: { percent: 47, resetsAt: null },
      week: { percent: 24, resetsAt: null },
      models: [],
      fetchedAt: "x",
      history: [],
    };
    expect(usage.summarize([], now, plan).plan).toBe(plan);
  });

  it("folds the long tail of projects into one row", () => {
    const sessions = "abcdefgh".split("").map((p, i) =>
      session({
        id: `vk-${p}-1`,
        project: p,
        endedAt: new Date(now - day).toISOString(),
        usage: u(1000 - i),
      }),
    );
    const { projects } = usage.summarize(sessions, now);
    expect(projects).toHaveLength(7);
    expect(projects.at(-1)).toEqual({
      project: "2 other",
      total: 994 + 993,
      sessions: 2,
      costUsd: 0,
    });
  });
});

describe("backfillUsage", () => {
  it("measures sessions that ended before there was a measurement, once", async () => {
    writeTranscript("demo", [assistant("a", { output: 42 })]);
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-1.json"),
      JSON.stringify({
        id: "vk-demo-1",
        project: "demo",
        agent: "claude",
        title: "old",
        createdAt: "2026-08-01T00:00:00.000Z",
        endedAt: "2026-08-01T01:00:00.000Z",
      }),
    );
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-1.conv"), CONV);
    // No conversation recorded: measured as null and not tried again.
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-2.json"),
      JSON.stringify({
        id: "vk-demo-2",
        project: "demo",
        agent: "claude",
        title: "older",
        createdAt: "2026-07-01T00:00:00.000Z",
        endedAt: "2026-07-01T01:00:00.000Z",
      }),
    );

    expect(await store.backfillUsage()).toBe(2);
    expect(await store.backfillUsage()).toBe(0);
    const read = (id: string) =>
      JSON.parse(fs.readFileSync(path.join(sessionsDir, `${id}.json`), "utf8"));
    expect(read("vk-demo-1").usage).toMatchObject({ output: 42, turns: 1 });
    expect(read("vk-demo-2").usage).toBeNull();
  });
});
