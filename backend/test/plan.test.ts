import { describe, expect, it } from "vitest";
import { parsePlan } from "../src/plan.js";

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
