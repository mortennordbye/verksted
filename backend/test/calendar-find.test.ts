import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Finding one event (A-24), against a mocked tsdav.
 *
 * Every change and removal starts by finding the event, and that used to mean
 * downloading three years of every calendar. It is asked for by uid now, and
 * what is pinned is both halves of that: a server that answers the query is
 * asked nothing else, and a server that does not still has its event found.
 */
interface Asked {
  calendar: string;
  filters?: unknown;
  timeRange?: unknown;
}
const asked: Asked[] = [];
let answersUidQuery: "yes" | "empty" | "throws" = "yes";

const event = (uid: string, summary: string) =>
  [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DTSTART:20260922T100000Z",
    "DTEND:20260922T110000Z",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

const HOME = [{ url: "home/dentist.ics", data: event("dentist@x", "Dentist") }];
const WORK = [{ url: "work/review.ics", data: event("review@x", "Review") }];

vi.mock("tsdav", () => ({
  createDAVClient: async () => ({
    fetchCalendars: async () => [{ url: "home" }, { url: "work" }],
    fetchCalendarObjects: async (p: { calendar: { url: string } } & Omit<Asked, "calendar">) => {
      asked.push({ calendar: p.calendar.url, filters: p.filters, timeRange: p.timeRange });
      const all = p.calendar.url === "home" ? HOME : WORK;
      if (!p.filters) return all;
      if (answersUidQuery === "throws") throw new Error("400 unsupported filter");
      if (answersUidQuery === "empty") return [];
      return all.filter((o) =>
        JSON.stringify(p.filters).includes(o.data.split("UID:")[1].split("\r")[0]),
      );
    },
  }),
}));

let calendar: typeof import("../src/calendar.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-calfind-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: { CALDAV_URL: "https://dav.example.com", CALDAV_USER: "u", CALDAV_PASSWORD: "p" },
    }),
  );
  process.env.ASSISTANT_DIR = path.join(dir, "assistant");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-calfind-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-calfind-s-"));
  calendar = await import("../src/calendar.js");
});

beforeEach(() => {
  asked.length = 0;
  answersUidQuery = "yes";
});

describe("finding an event by its uid", () => {
  it("asks each calendar for that uid, and never for three years of everything", async () => {
    expect((await calendar.peek("review@x")).summary).toBe("Review");

    expect(asked.map((a) => a.calendar)).toEqual(["home", "work"]);
    expect(asked.every((a) => a.filters && !a.timeRange)).toBe(true);
    expect(JSON.stringify(asked[0].filters)).toContain('"name":"UID"');
    expect(JSON.stringify(asked[0].filters)).toContain("review@x");
  });

  it("stops at the calendar that has it", async () => {
    await calendar.peek("dentist@x");
    expect(asked.map((a) => a.calendar)).toEqual(["home"]);
  });

  it("still finds it on a server that answers the query with nothing, or refuses it", async () => {
    for (const mode of ["empty", "throws"] as const) {
      answersUidQuery = mode;
      asked.length = 0;
      expect((await calendar.peek("review@x")).summary, mode).toBe("Review");
      // The scan ran, which is the old behaviour and the floor.
      expect(
        asked.some((a) => a.timeRange),
        mode,
      ).toBe(true);
    }
  });

  it("says so when it is nowhere", async () => {
    await expect(calendar.peek("ghost@x")).rejects.toBeInstanceOf(calendar.CalendarNotFound);
  });
});
