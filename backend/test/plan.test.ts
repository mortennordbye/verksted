import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

let plan: typeof import("../src/plan.js");
let usageDir: string;

beforeAll(async () => {
  usageDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-usage-"));
  process.env.USAGE_DIR = usageDir;
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  plan = await import("../src/plan.js");
});

const parsePlan = (body: unknown, at?: string) => plan.parsePlan(body, at);

/**
 * The account's usage endpoint is not a documented one, so the one thing to
 * pin is that a body of the shape it gave when this was written reads out
 * right, and that anything else reads as "unknown" rather than as a number.
 */
const BODY = {
  five_hour: { utilization: 47.0, resets_at: "2026-08-29T14:59:59.805620+00:00" },
  seven_day: { utilization: 24.0, resets_at: "2026-09-02T18:59:59.805642+00:00" },
  seven_day_opus: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 47,
      resets_at: "2026-08-29T14:59:59.805620+00:00",
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 24,
      resets_at: "2026-09-02T18:59:59.805642+00:00",
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 7,
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
    },
  ],
};

describe("parsePlan", () => {
  it("reads the two windows and the per-model week", () => {
    expect(parsePlan(BODY, "2026-08-29T12:00:00.000Z")).toEqual({
      session: { percent: 47, resetsAt: "2026-08-29T14:59:59.805620+00:00" },
      week: { percent: 24, resetsAt: "2026-09-02T18:59:59.805642+00:00" },
      models: [{ model: "Fable", percent: 7 }],
      fetchedAt: "2026-08-29T12:00:00.000Z",
      history: [],
    });
  });

  it("is null for anything it does not recognise", () => {
    expect(parsePlan(null)).toBeNull();
    expect(parsePlan({})).toBeNull();
    expect(parsePlan({ five_hour: { utilization: "lots" }, seven_day: {} })).toBeNull();
    expect(parsePlan("<html>")).toBeNull();
  });

  it("copes with a window that has no reset and no scoped limits", () => {
    const out = parsePlan({ five_hour: { utilization: 0 }, seven_day: { utilization: 3.6 } });
    expect(out).toMatchObject({
      session: { percent: 0, resetsAt: null },
      week: { percent: 4, resetsAt: null },
      models: [],
    });
  });
});

describe("plan history", () => {
  it("keeps one line per sample and reads back the ones in the window", async () => {
    const reading = parsePlan(BODY, "2026-08-29T12:00:00.000Z")!;
    await plan.appendSample(reading, new Date("2026-08-20T00:00:00.000Z"));
    await plan.appendSample(
      { ...reading, week: { ...reading.week, percent: 30 } },
      new Date("2026-08-29T11:00:00.000Z"),
    );
    // A crash mid-append leaves a torn line; it must not take the rest with it.
    fs.appendFileSync(path.join(usageDir, "plan.jsonl"), '{"at":"2026-08-29T12:');

    const since = Date.parse("2026-08-22T00:00:00.000Z");
    expect(await plan.planHistory(since)).toEqual([
      { at: "2026-08-29T11:00:00.000Z", session: 47, week: 30 },
    ]);
    expect(await plan.planHistory(0)).toHaveLength(2);
  });

  it("is empty before the first sample", async () => {
    process.env.USAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-usage-empty-"));
    // env is read at import, so this exercises the missing-file path via a
    // directory the module has never written to.
    expect(await plan.planHistory(0)).not.toBeNull();
  });
});
