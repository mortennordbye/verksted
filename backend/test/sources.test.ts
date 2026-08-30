import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Mail and the calendar, short of a live server: the parsing that turns what
 * a server sends into what a screen or a model reads, the routes' answer when
 * nothing is set up, and the one property that matters most, that a mail
 * password typed on the settings page never reaches a session.
 */
let app: FastifyInstance;
let calendar: typeof import("../src/calendar.js");
let mail: typeof import("../src/mail.js");
let pollers: typeof import("../src/pollers.js");
let settings: typeof import("../src/settings-store.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sources-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  calendar = await import("../src/calendar.js");
  mail = await import("../src/mail.js");
  pollers = await import("../src/pollers.js");
  settings = await import("../src/settings-store.js");
});

afterAll(async () => {
  await app.close();
});

const ICS = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:abc-1",
  "DTSTART:20260830T080000Z",
  "DTEND:20260830T083000Z",
  "SUMMARY:Standup",
  "DESCRIPTION:Join at https://meet.example/abc\\nBring the numbers\\, please",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:abc-2",
  "DTSTART;VALUE=DATE:20260830",
  "SUMMARY:Kari's birthday",
  "END:VEVENT",
  "BEGIN:VEVENT",
  "UID:abc-3",
  "DTSTART;TZID=Europe/Oslo:20260830T143000",
  "DTEND;TZID=Europe/Oslo:20260830T151500",
  "SUMMARY:Tannlege",
  "LOCATION:Storgata 1",
  " , Oslo",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

describe("the calendar", () => {
  it("reads the three shapes of date, a folded line and an escaped description", () => {
    const [standup, birthday, dentist] = calendar.parseIcs(ICS, "home");
    expect(standup.start).toBe("2026-08-30T08:00:00.000Z");
    expect(standup.end).toBe("2026-08-30T08:30:00.000Z");
    expect(standup.url).toBe("https://meet.example/abc");
    expect(standup.description).toBe("Join at https://meet.example/abc\nBring the numbers, please");
    expect(standup.calendar).toBe("home");

    expect(birthday.allDay).toBe(true);
    expect(new Date(birthday.start).getDate()).toBe(30);
    // No DTEND on an all-day event: the day.
    expect(Date.parse(birthday.end) - Date.parse(birthday.start)).toBe(86_400_000);

    expect(dentist.allDay).toBe(false);
    expect(new Date(dentist.start).getHours()).toBe(14);
    expect(dentist.location).toBe("Storgata 1, Oslo");
    expect(dentist.url).toBeNull();
  });

  it("files only what starts soon and has somewhere to be", () => {
    const now = Date.parse("2026-08-30T07:45:00.000Z");
    const events = calendar.parseIcs(ICS);
    const items = pollers.calendarItems(events, now);
    expect(items.map((i) => i.id)).toEqual(["calendar:abc-1:2026-08-30T08:00:00.000Z"]);
    expect(items[0].urgency).toBe("attention");
    expect(items[0].link).toBe("https://meet.example/abc");
    // An hour earlier, nothing is soon.
    expect(pollers.calendarItems(events, now - 3_600_000)).toEqual([]);
  });
});

describe("mail", () => {
  it("reduces an envelope to a line, and HTML to text", () => {
    const s = mail.summarise({
      uid: 42,
      envelope: {
        subject: "  Faktura 1234 ",
        date: new Date("2026-08-30T06:00:00Z"),
        from: [{ name: "Skatteetaten", address: "noreply@skatteetaten.no" }],
      },
      flags: new Set(),
    });
    expect(s).toEqual({
      uid: 42,
      subject: "Faktura 1234",
      from: "Skatteetaten",
      address: "noreply@skatteetaten.no",
      at: "2026-08-30T06:00:00.000Z",
      unread: true,
    });
    expect(
      mail.htmlToText("<style>p{}</style><p>Hei&nbsp;Morten,</p><p>Frist er <b>15. sept</b>.</p>"),
    ).toBe("Hei Morten,\nFrist er 15. sept.");
    expect(pollers.mailItems([s])[0]).toMatchObject({
      id: "mail:42",
      title: "Skatteetaten: Faktura 1234",
      version: "42",
    });
  });
});

describe("the routes", () => {
  it("say a source is not set up rather than failing", async () => {
    expect((await app.inject({ url: "/api/sources" })).json()).toMatchObject({
      mail: false,
      calendar: false,
    });
    const res = await app.inject({ url: "/api/mail" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/IMAP_HOST/);
    expect((await app.inject({ url: "/api/calendar/today" })).statusCode).toBe(503);
  });

  it("keep a mail password out of every session, and give it only to the readers", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        vars: {
          IMAP_HOST: "imap.example",
          IMAP_USER: "m",
          IMAP_PASSWORD: "hunter2",
          GH_TOKEN: "gh",
        },
      },
    });
    const forSessions = await settings.agentEnv();
    expect(forSessions.IMAP_PASSWORD).toBeUndefined();
    expect(forSessions.IMAP_HOST).toBeUndefined();
    expect(forSessions.GH_TOKEN).toBe("gh");
    const forReaders = await settings.sourceEnv();
    expect(forReaders).toEqual({
      IMAP_HOST: "imap.example",
      IMAP_USER: "m",
      IMAP_PASSWORD: "hunter2",
    });
    expect((await app.inject({ url: "/api/sources" })).json().mail).toBe(true);
  });
});
