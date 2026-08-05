import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

let app: FastifyInstance;
let schedulesDir: string;
let sessionsDir: string;
let reposDir: string;

// A pattern that cannot fire during the run, so the timers the routes start
// never actually launch a session.
const CRON = "17 4 1 1 *";

async function create(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/schedules", payload: body });
}

beforeAll(async () => {
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  fs.mkdirSync(path.join(reposDir, "other"));
  schedulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));

  // env.ts snapshots process.env at first import, so set these before the app
  // module graph loads (each vitest file has its own module registry).
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = schedulesDir;
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  // Deleting every schedule reloads the scheduler down to zero live timers,
  // which is what lets the test process exit.
  for (const s of (await app.inject({ url: "/api/schedules" })).json()) {
    await app.inject({ method: "DELETE", url: `/api/schedules/${s.id}` });
  }
  await app.close();
});

describe("POST /api/schedules", () => {
  it("stores a schedule and reports when it fires next", async () => {
    const res = await create({
      name: "merge check",
      project: "demo",
      cron: CRON,
      prompt: "check the open PRs",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toMatch(/^sch-[0-9a-f]{8}$/);
    expect(body.enabled).toBe(true);
    expect(body.lastRunAt).toBeNull();
    expect(Date.parse(body.nextRunAt)).toBeGreaterThan(Date.now());
    expect(fs.existsSync(path.join(schedulesDir, `${body.id}.json`))).toBe(true);
  });

  it("rejects a pattern cron cannot parse", async () => {
    const res = await create({
      name: "bad",
      project: "demo",
      cron: "every tuesday",
      prompt: "x",
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown project, and one escaping the repos root", async () => {
    for (const project of ["nope", "../etc", "demo/../.."]) {
      const res = await create({ name: "x", project, cron: CRON, prompt: "x" });
      expect(res.statusCode).toBe(404);
    }
  });

  it("defaults jitter to none and rejects one outside the window", async () => {
    const plain = await create({ name: "j", project: "demo", cron: CRON, prompt: "x" });
    expect(plain.json().jitterMinutes).toBe(0);

    const spread = await create({
      name: "j2",
      project: "demo",
      cron: CRON,
      prompt: "x",
      jitterMinutes: 30,
    });
    expect(spread.json().jitterMinutes).toBe(30);

    for (const jitterMinutes of [-1, 721, 1.5]) {
      const res = await create({
        name: "j3",
        project: "demo",
        cron: CRON,
        prompt: "x",
        jitterMinutes,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("rejects an empty prompt, and drops fields the client made up", async () => {
    expect((await create({ name: "x", project: "demo", cron: CRON, prompt: "" })).statusCode).toBe(
      400,
    );
    // fastify's ajv strips additional properties rather than rejecting them, so
    // the guarantee to hold is that an invented field never reaches the record.
    const res = await create({
      name: "x",
      project: "demo",
      cron: CRON,
      prompt: "x",
      autoPermissions: false,
      id: "sch-00000000",
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).not.toHaveProperty("autoPermissions");
    expect(res.json().id).not.toBe("sch-00000000");
  });
});

describe("PATCH /api/schedules/:id", () => {
  it("edits the prompt and pauses, and a paused schedule has no next run", async () => {
    const id = (await create({ name: "p", project: "demo", cron: CRON, prompt: "old" })).json().id;
    let res = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${id}`,
      payload: { prompt: "new", enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().prompt).toBe("new");
    expect(res.json().nextRunAt).toBeNull();

    // Still stored with its project — patching cannot move it to another repo.
    expect(res.json().project).toBe("demo");

    res = await app.inject({
      method: "PATCH",
      url: `/api/schedules/${id}`,
      payload: { cron: "not a cron" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s on an unknown id and never leaves the schedules dir", async () => {
    for (const id of ["sch-deadbeef", "..%2f..%2fetc", "nope"]) {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/schedules/${id}`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe("DELETE /api/schedules/:id", () => {
  it("removes the file, and 404s the second time", async () => {
    const id = (await create({ name: "d", project: "demo", cron: CRON, prompt: "x" })).json().id;
    expect((await app.inject({ method: "DELETE", url: `/api/schedules/${id}` })).statusCode).toBe(
      200,
    );
    expect(fs.existsSync(path.join(schedulesDir, `${id}.json`))).toBe(false);
    expect((await app.inject({ method: "DELETE", url: `/api/schedules/${id}` })).statusCode).toBe(
      404,
    );
  });
});

describe("GET /api/projects/:name/schedules", () => {
  it("returns only the schedules that run in that repo", async () => {
    const mine = (
      await create({ name: "scoped", project: "other", cron: CRON, prompt: "x" })
    ).json().id;
    const res = await app.inject({ url: "/api/projects/other/schedules" });
    expect(res.statusCode).toBe(200);
    expect(res.json().map((s: { id: string }) => s.id)).toEqual([mine]);
    // The demo repo has schedules of its own from the tests above, and none of
    // them is this one — the filter is not just "everything".
    const demo = (await app.inject({ url: "/api/projects/demo/schedules" })).json();
    expect(demo.length).toBeGreaterThan(0);
    expect(demo.map((s: { id: string }) => s.id)).not.toContain(mine);
  });

  // A bare ".." is not worth asserting, encoded or not: the path collapses to
  // /api/schedules before any handler sees it. Only a name carrying an encoded
  // separator survives routing and reaches the guard, so those are the cases.
  it("404s on a repo that does not exist, and on a traversal", async () => {
    for (const name of [
      "nope",
      "%2e%2e%2fetc",
      "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      ".hidden",
      "demo%2f.git",
    ]) {
      const res = await app.inject({ url: `/api/projects/${name}/schedules` });
      expect(res.statusCode, name).toBe(404);
    }
  });
});

describe("POST /api/schedules/:id/run", () => {
  it("404s on an unknown id", async () => {
    const res = await app.inject({ method: "POST", url: "/api/schedules/sch-deadbeef/run" });
    expect(res.statusCode).toBe(404);
  });
});

describe("the store's own guards", () => {
  it("only reads generated ids, so no path can be smuggled in", async () => {
    const store = await import("../src/schedules-store.js");
    fs.writeFileSync(path.join(schedulesDir, "evil.json"), JSON.stringify({ id: "evil" }));
    expect(await store.getSchedule("../../etc/passwd")).toBeNull();
    expect(await store.getSchedule("evil")).toBeNull();
    // …and a file that isn't a generated id is not listed either.
    const listed = await store.listSchedules();
    expect(listed.every((s) => /^sch-[0-9a-f]{8}$/.test(s.id))).toBe(true);
  });

  it("surfaces the verdict the last run wrote about itself", async () => {
    const store = await import("../src/schedules-store.js");
    const id = (await create({ name: "r", project: "demo", cron: CRON, prompt: "x" })).json().id;
    expect((await store.getSchedule(id))!.lastReport).toBeNull();

    await store.recordRun(id, { sessionId: "vk-demo-9" });
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-9.report"), "attention: #14 needs a review\n");
    const after = (await store.getSchedule(id))!;
    expect(after.lastReport).toBe("attention: #14 needs a review");
    expect(after.lastSessionId).toBe("vk-demo-9");
  });

  it("keeps a run history, newest first, and rolls each into one word", async () => {
    const store = await import("../src/schedules-store.js");
    const id = (await create({ name: "hist", project: "demo", cron: CRON, prompt: "x" })).json().id;

    await store.recordRun(id, { error: "previous run is still open" });
    await store.recordRun(id, { sessionId: "vk-demo-7" });
    fs.writeFileSync(path.join(sessionsDir, "vk-demo-7.report"), "ok: nothing to do\n");
    await store.recordRun(id, { sessionId: "vk-demo-8" });

    const mine = (await store.listRuns()).filter((r) => r.scheduleId === id);
    expect(mine).toHaveLength(3);
    // Newest first: the sessionless run is oldest, so it comes last.
    expect(mine.map((r) => r.outcome)).toEqual(["done", "ok", "blocked"]);
    expect(mine[1].report).toBe("ok: nothing to do");
    expect(mine[2].error).toBe("previous run is still open");
    expect(mine[0].schedule).toBe("hist");
  });

  it("caps the history so a schedule file cannot grow forever", async () => {
    const store = await import("../src/schedules-store.js");
    const id = (await create({ name: "cap", project: "demo", cron: CRON, prompt: "x" })).json().id;
    for (let i = 0; i < 25; i++) await store.recordRun(id, { sessionId: `vk-demo-${i}` });
    expect((await store.listRuns(100)).filter((r) => r.scheduleId === id)).toHaveLength(20);
  });

  it("accepts real cron patterns and rejects prose", async () => {
    const { validCron } = await import("../src/schedules-store.js");
    for (const ok of ["0 8 * * 1-5", "*/15 * * * *", "0 7 * * *"]) {
      expect(validCron(ok)).toBe(true);
    }
    for (const bad of ["", "every day", "99 * * * *", "0 8 * *"]) {
      expect(validCron(bad)).toBe(false);
    }
  });
});
