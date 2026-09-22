import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CALENDAR, startDavServer, type DavServer } from "./helpers/dav-server.js";

/**
 * The calendar against a CalDAV server over real HTTP, through the real tsdav
 * (A-32). The other calendar tests mock tsdav, which pins what calendar.ts asks
 * for but not that a server's answer to it comes back as an event, that a
 * write reaches the server as a PUT or DELETE, or that a server which accepts
 * a request and then says nothing lets go of the call behind it.
 */

let dav: DavServer;
let calendar: typeof import("../src/calendar.js");
let dir: string;

const event = (uid: string, summary: string, start = "20260922T100000Z") =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `DTSTART:${start}`,
    "DTEND:20260922T110000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");

beforeAll(async () => {
  dav = await startDavServer();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-caldav-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({ vars: { CALDAV_URL: dav.url, CALDAV_USER: "u", CALDAV_PASSWORD: "p" } }),
  );
  process.env.ASSISTANT_DIR = path.join(dir, "assistant");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-caldav-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-caldav-s-"));
  calendar = await import("../src/calendar.js");
});

afterAll(async () => {
  calendar.setDavTimeout(20_000);
  await dav.close();
});

beforeEach(() => {
  dav.objects.clear();
  dav.requests.length = 0;
  dav.hang = false;
});

describe("the calendar over CalDAV", () => {
  it("reads an event the server holds", async () => {
    dav.objects.set(`${CALENDAR}dentist.ics`, { data: event("dentist@x", "Dentist"), etag: '"1"' });

    const got = await calendar.events(
      new Date("2026-09-22T00:00:00Z"),
      new Date("2026-09-23T00:00:00Z"),
    );

    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ uid: "dentist@x", summary: "Dentist" });
  });

  it("writes a new event as a PUT of a file of its own", async () => {
    const { uid } = await calendar.put({
      summary: "Lunch",
      start: "2026-09-22T11:00:00Z",
      end: "2026-09-22T12:00:00Z",
    });

    const stored = dav.objects.get(`${CALENDAR}${uid}.ics`);
    expect(stored?.data).toContain(`UID:${uid}`);
    expect(stored?.data).toContain("SUMMARY:Lunch");
  });

  it("changes an event in place, found by its uid", async () => {
    dav.objects.set(`${CALENDAR}review.ics`, { data: event("review@x", "Review"), etag: '"1"' });

    const changed = await calendar.update("review@x", { summary: "Design review" });

    expect(changed.summary).toBe("Design review");
    expect(dav.objects.get(`${CALENDAR}review.ics`)?.data).toContain("SUMMARY:Design review");
    // Asked for by uid, not by three years of everything (A-24): a query for
    // the uid, then tsdav's multiget of what it named, and no time range.
    const reports = dav.requests.filter((r) => r.method === "REPORT");
    expect(reports[0]?.body).toContain("review@x");
    expect(reports.some((r) => r.body.includes("time-range"))).toBe(false);
  });

  it("removes an event with a DELETE, keeping a copy first", async () => {
    dav.objects.set(`${CALENDAR}gone.ics`, { data: event("gone@x", "Gone"), etag: '"1"' });

    const removed = await calendar.remove("gone@x");

    expect(removed.summary).toBe("Gone");
    expect(dav.objects.has(`${CALENDAR}gone.ics`)).toBe(false);
    expect(dav.requests.some((r) => r.method === "DELETE")).toBe(true);
    const kept = fs.readdirSync(calendar.calendarTrashDir());
    expect(kept.some((f) => f.includes("gone@x"))).toBe(true);
  });

  it("gives up on a server that accepts a request and never answers", async () => {
    dav.hang = true;
    calendar.setDavTimeout(300);
    const started = Date.now();
    try {
      await expect(calendar.today()).rejects.toThrow();
    } finally {
      calendar.setDavTimeout(20_000);
    }
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(dav.requests.length).toBeGreaterThan(0);
  });
});
