import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * O-25: four routes and the cache in front of two of them that no test had
 * reached. Each case is what the screen reading the route depends on.
 */
let app: FastifyInstance;
let fake: FakeBin;
let reposDir: string;
let sessionsDir: string;
let schedulesDir: string;

const month = new Date().toISOString().slice(0, 7);
const usage = (input: number) => ({
  input,
  output: 10,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 1,
  costUsd: 0.01,
});
const archived = (id: string, input: number) =>
  JSON.stringify({
    id,
    project: "demo",
    agent: "claude",
    title: id,
    status: "done",
    createdAt: new Date(Date.now() - 7_200_000).toISOString(),
    endedAt: new Date(Date.now() - 3_600_000).toISOString(),
    usage: usage(input),
  });

beforeAll(async () => {
  fake = FakeBin.install(["tmux", "gh"]);
  fake.reply("tmux", "ls", { stdout: "" });

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  fs.mkdirSync(path.join(reposDir, "other"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  schedulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));

  // Retired sessions, one of them written twice as a crash mid-retirement
  // would leave it.
  fs.mkdirSync(path.join(sessionsDir, "archive"));
  fs.writeFileSync(
    path.join(sessionsDir, "archive", `${month}.jsonl`),
    [archived("vk-demo-1", 100), archived("vk-demo-2", 200), archived("vk-demo-2", 200)].join(
      "\n",
    ) + "\n",
  );

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = schedulesDir;
  process.env.STATIC_DIR = "";
  // No account credentials here: the plan half of /api/usage has nothing to read.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "vk-home-"));
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  const all: { id: string }[] = (await app.inject({ url: "/api/schedules" })).json();
  for (const s of all) {
    await app.inject({ method: "DELETE", url: `/api/schedules/${s.id}` });
  }
  await app.close();
  fake.uninstall();
});

describe("GET /api/usage", () => {
  it("adds up the retired sessions, each once, and says the plan could not be read", async () => {
    const res = await app.inject({ url: "/api/usage" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const allTime = body.windows.find((w: { days: number | null }) => !w.days);
    expect(allTime.sessions).toBe(2);
    expect(allTime.tokens.input).toBe(300);
    expect(body.plan).toBeNull();
  });
});

describe("GET /api/runs", () => {
  it("lists what each schedule did, newest first, failures included", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/schedules",
      payload: { name: "nightly", project: "demo", cron: "0 3 * * *", prompt: "look around" },
    });
    const { id }: { id: string } = created.json();
    const file = path.join(schedulesDir, `${id}.json`);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.runs = [
      { at: new Date(Date.now() - 86_400_000).toISOString(), sessionId: null, error: null },
      { at: new Date().toISOString(), sessionId: null, error: "gh is not signed in" },
    ];
    fs.writeFileSync(file, JSON.stringify(stored));

    const runs: { schedule: string; error: string | null }[] = (
      await app.inject({ url: "/api/runs" })
    ).json();
    expect(runs.map((r) => r.schedule)).toEqual(["nightly", "nightly"]);
    expect(runs[0]?.error).toBe("gh is not signed in");
  });
});

describe("GET /api/maintainer/queue", () => {
  it("reads the queue of every repo a stage runs in, and skips one that has gone", async () => {
    for (const project of ["demo", "other"]) {
      await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: {
          name: `scout ${project}`,
          project,
          cron: "0 3 * * *",
          prompt: "",
          stage: "scout",
        },
      });
    }
    // Deleted after its schedule was made: the route must not blank the rest.
    fs.rmSync(path.join(reposDir, "other"), { recursive: true });

    const issue = { number: 7, title: "tidy the parser", labels: [], url: "u", updatedAt: "t" };
    fake.reply("gh", "issue list --state open --label queued", { stdout: JSON.stringify([issue]) });
    fake.reply("gh", "issue list", { stdout: "[]" });

    const res = await app.inject({ url: "/api/maintainer/queue" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ project: "demo", number: 7, state: "queued" }),
    ]);
  });
});

describe("ttlCache", () => {
  it("shares one call between callers inside the window, and does not keep a failure", async () => {
    const { ttlCache } = await import("../src/cache.js");
    let calls = 0;
    let fail = true;
    const cached = ttlCache(1_000, async (key: string) => {
      calls++;
      if (fail) throw new Error("down");
      return `${key}:${calls}`;
    });

    await expect(cached("a")).rejects.toThrow("down");
    fail = false;
    // The failure was dropped, so this is a fresh call rather than the error again.
    const [first, second] = await Promise.all([cached("a"), cached("a")]);
    expect(first).toBe("a:2");
    expect(second).toBe("a:2");
    expect(calls).toBe(2);

    vi.useFakeTimers({ now: Date.now() + 1_500 });
    try {
      expect(await cached("a")).toBe("a:3");
    } finally {
      vi.useRealTimers();
    }
  });
});
