import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * A cron pattern is wall-clock time, so "0 7 * * *" has to mean 07:00 where the
 * person who wrote it lives. The pod used to run UTC with croner reading the
 * ambient process zone, which fired every schedule two hours late for half the
 * year without anything looking wrong.
 *
 * TZ is deliberately unset here, so the process itself is on the container's
 * zone (UTC in CI). Anything Oslo-shaped in the result therefore came from the
 * timezone the store passes croner explicitly, which is the wiring under test.
 */
let store: typeof import("../src/schedules-store.js");

const hourIn = (zone: string, iso: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hour12: false }).format(
    new Date(iso),
  );

beforeAll(async () => {
  delete process.env.TZ;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  store = await import("../src/schedules-store.js");
});

describe("cron patterns are read in the bench's timezone", () => {
  it("puts a 07:00 pattern at 07:00 in Oslo, not in UTC", async () => {
    const iso = store.nextRun("0 7 * * *", true);

    expect(iso).not.toBeNull();
    expect(hourIn("Europe/Oslo", iso!)).toBe("07");
    // Oslo is never at UTC+0, so a run that is 07:00 there cannot also be 07:00
    // here — which is what a croner left on the process zone would have given.
    expect(hourIn("UTC", iso!)).not.toBe("07");
  });

  it("still refuses a pattern croner cannot parse", () => {
    expect(store.validCron("not a cron")).toBe(false);
    expect(store.validCron("0 7 * * *")).toBe(true);
  });

  it("has no next run when the schedule is off", () => {
    expect(store.nextRun("0 7 * * *", false)).toBeNull();
  });
});
