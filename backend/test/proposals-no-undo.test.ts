import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FeedItem, ToolLogDay, ToolLogEntry } from "../../shared/api.js";

/**
 * The mail and calendar changes with no way back, as cards (A-08, A-09).
 *
 * Three things are pinned for each. Nothing happens when the card is filed.
 * What the card shows is what the account holds, whatever the caller sent in
 * its place. And there is no other door: the routes that used to do these for
 * whoever asked are gone, so the tap is the only way to the function.
 *
 * Gmail is a stubbed fetch, CalDAV a mocked tsdav and IMAP a mocked imapflow,
 * each the smallest thing that answers what these paths ask.
 */
let filters = [
  { id: "F1", criteria: { from: "bank@example.com" }, action: { addLabelIds: ["L1"] } },
];
let userLabels = [
  { id: "L1", name: "Bank", type: "user" },
  { id: "L2", name: "Unused", type: "user" },
];
const gmailWrites: string[] = [];
/** Which messages carry each label id, and whether Gmail has another page of them. */
let carrying: Record<string, string[]> = {};
let morePages = false;
const batchModifies: unknown[] = [];

function fakeFetch(url: string, init: { method?: string; body?: string } = {}) {
  const method = init.method ?? "GET";
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status }));
  if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "tok" });
  if (method !== "GET") gmailWrites.push(`${method} ${url.split("/users/me")[1]}`);
  if (url.endsWith("/labels") && method === "POST") {
    const made = {
      id: "L9",
      type: "user",
      name: (JSON.parse(init.body ?? "{}") as { name: string }).name,
    };
    userLabels = [...userLabels, made];
    return json(made);
  }
  if (url.endsWith("/labels")) return json({ labels: userLabels });
  const listed = /\/messages\?(.*)$/.exec(url);
  if (listed && method === "GET") {
    const q = new URLSearchParams(listed[1]);
    const ids = (carrying[q.get("labelIds") ?? ""] ?? []).slice(0, Number(q.get("maxResults")));
    return json({
      messages: ids.map((id) => ({ id })),
      ...(morePages ? { nextPageToken: "p2" } : {}),
    });
  }
  if (url.endsWith("/messages/batchModify")) {
    batchModifies.push(JSON.parse(init.body ?? "{}"));
    return json(null, 204);
  }
  if (url.endsWith("/settings/filters") && method === "GET") return json({ filter: filters });
  if (url.endsWith("/settings/filters") && method === "POST") {
    const created = { id: "F2", ...(JSON.parse(init.body ?? "{}") as object) };
    filters = [...filters, created as (typeof filters)[number]];
    return json(created);
  }
  const filter = /\/settings\/filters\/(\w+)$/.exec(url);
  if (filter && method === "DELETE") {
    filters = filters.filter((f) => f.id !== filter[1]);
    return json(null, 204);
  }
  const label = /\/labels\/(\w+)$/.exec(url);
  if (label && method === "DELETE") {
    userLabels = userLabels.filter((l) => l.id !== label[1]);
    return json(null, 204);
  }
  return json({ error: { message: `unexpected ${method} ${url}` } }, 500);
}

const event = (uid: string, summary: string, extra = "") =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DTSTART:20260922T100000Z",
    "DTEND:20260922T110000Z",
    ...(extra ? [extra] : []),
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");

let objects: { url: string; data: string }[] = [];
const davDeletes: string[] = [];

vi.mock("tsdav", () => ({
  createDAVClient: async () => ({
    fetchCalendars: async () => [{ url: "cal", displayName: "Home" }],
    fetchCalendarObjects: async () => objects,
    deleteCalendarObject: async (o: { calendarObject: { url: string } }) => {
      davDeletes.push(o.calendarObject.url);
      objects = objects.filter((x) => x.url !== o.calendarObject.url);
      return { ok: true };
    },
    updateCalendarObject: async () => ({ ok: true }),
  }),
}));

const moves: { uids: unknown; to: string }[] = [];

vi.mock("imapflow", async () => {
  // An EventEmitter, as the real one is: the kept connection listens for close.
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      async connect() {}
      async logout() {}
      async getMailboxLock() {
        return { release() {} };
      }
      async list() {
        return [
          { path: "INBOX", name: "INBOX", flags: new Set<string>(), specialUse: "\\Inbox" },
          { path: "[Gmail]/Spam", name: "Spam", flags: new Set<string>(), specialUse: "\\Junk" },
          { path: "Receipts", name: "Receipts", flags: new Set<string>(), specialUse: undefined },
        ];
      }
      async *fetch(uids: number[]) {
        for (const uid of uids.filter((u) => u < 100)) {
          yield {
            uid,
            envelope: { subject: `You won, claim ${uid}`, from: [{ name: "Lottery" }] },
            flags: new Set<string>(),
          };
        }
      }
      async messageMove(uids: unknown, to: string) {
        moves.push({ uids, to });
        return { uidMap: new Map([[7, 70]]) };
      }
    },
  };
});

let app: FastifyInstance;
let assistantDir: string;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-noundo-"));
  assistantDir = path.join(dir, "assistant");
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.PUSH_FILE = path.join(dir, "push.json");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: {
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
        GOOGLE_REFRESH_TOKEN: "refresh",
        IMAP_HOST: "imap.gmail.com",
        IMAP_USER: "someone@example.com",
        IMAP_PASSWORD: "x",
        CALDAV_URL: "https://dav.example.com",
        CALDAV_USER: "someone",
        CALDAV_PASSWORD: "x",
      },
    }),
  );
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-noundo-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-noundo-s-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-noundo-c-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  filters = [{ id: "F1", criteria: { from: "bank@example.com" }, action: { addLabelIds: ["L1"] } }];
  userLabels = [
    { id: "L1", name: "Bank", type: "user" },
    { id: "L2", name: "Unused", type: "user" },
  ];
  gmailWrites.length = 0;
  carrying = { L1: ["m1"], L2: ["m2", "m3"] };
  morePages = false;
  batchModifies.length = 0;
  objects = [
    { url: "cal/dentist.ics", data: event("dentist@x", "Dentist") },
    { url: "cal/standup.ics", data: event("standup@x", "Standup", "RRULE:FREQ=DAILY") },
  ];
  davDeletes.length = 0;
  moves.length = 0;
});

const propose = (action: Record<string, unknown>) =>
  app.inject({ method: "POST", url: "/api/proposals", payload: { action } });
const tap = (id: string) =>
  app.inject({ method: "POST", url: `/api/proposals/${encodeURIComponent(id)}/do` });
/** The newest line of the log for a tapped card of this kind. */
async function cardLine(tool: string): Promise<ToolLogEntry & { day: string }> {
  const log = (await app.inject({ url: "/api/assistant/tool-log" })).json<ToolLogDay>();
  const line = log.entries.filter((e) => e.tool === tool).at(-1);
  if (!line || !log.day) throw new Error(`no ${tool} in the log`);
  return { ...line, day: log.day };
}
const undoLine = (line: { day: string; at: string }) =>
  app.inject({
    method: "POST",
    url: "/api/assistant/tool-log/undo",
    payload: { day: line.day, at: line.at },
  });

describe("a Gmail filter", () => {
  it("is removed on the tap, and the card shows the filter the account holds", async () => {
    const res = await propose({
      kind: "mail_rule_delete",
      id: "F1",
      // Not the caller's to say.
      rule: { id: "F1", from: "newsletter@example.com", archive: true, markRead: false },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json<FeedItem>();
    expect(item.action).toMatchObject({
      rule: { id: "F1", from: "bank@example.com", label: "Bank" },
    });
    expect(item.title).toContain("from:bank@example.com -> label Bank");
    expect(gmailWrites).toEqual([]);

    expect((await tap(item.id)).statusCode).toBe(200);
    expect(gmailWrites).toEqual(["DELETE /settings/filters/F1"]);
  });

  it("is refused as it is filed when there is no such filter, or nothing for one to do", async () => {
    expect((await propose({ kind: "mail_rule_delete", id: "F9" })).statusCode).toBe(400);
    expect((await propose({ kind: "mail_rule_put", from: "a@b.no" })).statusCode).toBe(400);
    expect((await propose({ kind: "mail_rule_put", archive: true })).statusCode).toBe(400);
  });

  it("is added on the tap and not before", async () => {
    const res = await propose({ kind: "mail_rule_put", from: "a@b.no", archive: true });
    expect(res.statusCode).toBe(201);
    expect(gmailWrites).toEqual([]);

    await tap(res.json<FeedItem>().id);
    expect(gmailWrites).toEqual(["POST /settings/filters"]);
  });
});

describe("a Gmail label", () => {
  it("is deleted on the tap, and one that is not there is refused as it is filed", async () => {
    expect((await propose({ kind: "mail_label_delete", name: "Nope" })).statusCode).toBe(400);

    const res = await propose({ kind: "mail_label_delete", name: "Unused" });
    expect(gmailWrites).toEqual([]);
    await tap(res.json<FeedItem>().id);
    expect(gmailWrites).toEqual(["DELETE /labels/L2"]);
  });

  it("records what carried it on the tap, and the log puts it back on exactly those", async () => {
    const res = await propose({ kind: "mail_label_delete", name: "Unused", messages: ["x9"] });
    const item = res.json<FeedItem>();
    // What the account says carries it, not what the caller sent.
    expect(item.action).toEqual({
      kind: "mail_label_delete",
      name: "Unused",
      messages: ["m2", "m3"],
    });
    expect(item.detail).toContain("comes off 2 messages");

    // Labelled since the card was filed: the tap reads it again.
    carrying.L2 = ["m2", "m3", "m4"];
    await tap(item.id);
    const line = await cardLine("card:mail_label_delete");
    expect(line).toMatchObject({ undo: "can", args: { messages: ["m2", "m3", "m4"] } });

    const back = await undoLine(line);
    expect(back.statusCode).toBe(200);
    expect(back.json().said).toBe("the label Unused is back on 3 messages");
    // Made again by name, since its old id went with it, and put on those three.
    expect(userLabels.find((l) => l.name === "Unused")?.id).toBe("L9");
    expect(batchModifies).toEqual([{ ids: ["m2", "m3", "m4"], addLabelIds: ["L9"] }]);
  });

  it("says when there were more messages than it kept", async () => {
    carrying.L2 = Array.from({ length: 600 }, (_, i) => `m${i}`);
    morePages = true;
    const res = await propose({ kind: "mail_label_delete", name: "Unused" });
    const item = res.json<FeedItem>();
    expect(item.detail).toContain("more than 500 messages");
    await tap(item.id);
    const line = await cardLine("card:mail_label_delete");
    expect((line.args as { messages: string[] }).messages).toHaveLength(500);

    const back = await undoLine(line);
    expect(back.json().said).toMatch(/is back on 500 messages; only the first 500 were recorded/);
    expect((batchModifies[0] as { ids: string[] }).ids).toHaveLength(500);
  });

  it("stays when a filter still files into it, and the card says why", async () => {
    const res = await propose({ kind: "mail_label_delete", name: "Bank" });
    const done = await tap(res.json<FeedItem>().id);
    expect(done.statusCode).toBe(502);
    expect(done.json().error).toContain("still files into Bank");
    expect(gmailWrites).toEqual([]);
  });
});

describe("an event", () => {
  it("is taken off on the tap, and its file is kept first", async () => {
    const res = await propose({
      kind: "calendar_delete",
      uid: "dentist@x",
      event: { summary: "Something harmless" },
    });
    expect(res.statusCode).toBe(201);
    const item = res.json<FeedItem>();
    expect(item.title).toBe("Take off the calendar: Dentist");
    expect(davDeletes).toEqual([]);

    expect((await tap(item.id)).statusCode).toBe(200);
    expect(davDeletes).toEqual(["cal/dentist.ics"]);
    const trash = path.join(assistantDir, "calendar-trash");
    const [kept] = fs.readdirSync(trash);
    expect(fs.readFileSync(path.join(trash, kept), "utf8")).toContain("SUMMARY:Dentist");
    // The tap is a line of the log, which is where it can be put back from.
    const day = (await app.inject({ url: "/api/assistant/tool-log" })).json();
    const line = day.entries.find((e: { tool: string }) => e.tool === "card:calendar_delete");
    expect(line).toMatchObject({ speaker: "you, by card", ok: true, undo: "can" });
  });

  it("is refused as it is filed when it repeats and nobody said which, or is not there", async () => {
    const which = await propose({ kind: "calendar_delete", uid: "standup@x" });
    expect(which.statusCode).toBe(400);
    expect(which.json().error).toContain("repeats");
    expect((await propose({ kind: "calendar_delete", uid: "ghost@x" })).statusCode).toBe(400);
    expect(
      (
        await propose({
          kind: "calendar_delete",
          uid: "standup@x",
          every: true,
          occurrence: "2026-09-22",
        })
      ).statusCode,
    ).toBe(400);

    const every = await propose({ kind: "calendar_delete", uid: "standup@x", every: true });
    expect(every.statusCode).toBe(201);
    expect(every.json<FeedItem>().detail).toContain("every occurrence");
  });
});

describe("a move into the junk folder or the trash", () => {
  it("is refused by the route, which has no way to say a card was tapped", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/mail/move",
      payload: { uids: [7], to: "[Gmail]/Spam" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("card");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/mail/move",
          payload: { uids: [7], to: "[Gmail]/Spam", discard: true },
        })
      ).statusCode,
    ).toBe(400);
    expect(moves).toEqual([]);
  });

  it("shows the subjects it would move, and moves them on the tap", async () => {
    const res = await propose({
      kind: "mail_move",
      uids: [7],
      to: "[Gmail]/Spam",
      subjects: ["Nothing to see"],
    });
    expect(res.statusCode).toBe(201);
    const item = res.json<FeedItem>();
    expect(item.action).toMatchObject({ subjects: ["Lottery: You won, claim 7"] });
    expect(moves).toEqual([]);

    await tap(item.id);
    expect(moves).toEqual([{ uids: [7], to: "[Gmail]/Spam" }]);
  });

  it("is refused as it is filed when none of the messages are there", async () => {
    const res = await propose({ kind: "mail_move", uids: [500], to: "[Gmail]/Spam" });
    expect(res.statusCode).toBe(400);
  });
});

describe("the doors that used to be open", () => {
  it("are gone: only a tapped card reaches these", async () => {
    for (const [method, url, payload] of [
      ["POST", "/api/mail/rules", { from: "a@b.no", archive: true }],
      ["DELETE", "/api/mail/rules/F1", undefined],
      ["DELETE", "/api/mail/labels", { name: "Unused" }],
      ["DELETE", "/api/calendar/events/dentist%40x", undefined],
    ] as const) {
      const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
    }
    expect(gmailWrites).toEqual([]);
    expect(davDeletes).toEqual([]);
  });
});
