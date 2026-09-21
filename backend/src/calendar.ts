import fs from "node:fs/promises";
import path from "node:path";
import { createDAVClient } from "tsdav";
import type { CalendarEvent } from "../../shared/api.js";
import { env } from "./env.js";
import { GOOGLE_CALDAV_URL, TOKEN_URL } from "./google-auth.js";
import { sourceEnv } from "./settings-store.js";

/**
 * The calendar, over CalDAV.
 *
 * Google, iCloud and Fastmail all expose it. Google is signed in to with OAuth
 * (google-auth.ts), since its CalDAV refuses passwords; the others take a user
 * and an app password, like mail. Both live beside the mail credentials. Reads ask the server to expand
 * recurrences inside the window, so a weekly meeting is a row per week rather
 * than a rule to interpret here. Writes add, edit or remove one event, when
 * the person asked for it or tapped a card. A repeating one is changed only
 * when the change says which part, one occurrence or every one, since "move
 * it" could mean one Tuesday or all of them.
 */
export type CalendarConfig =
  | { kind: "basic"; url: string; user: string; password: string }
  | { kind: "google"; user: string; clientId: string; clientSecret: string; refreshToken: string };

export async function calendarConfig(): Promise<CalendarConfig | null> {
  const vars = await sourceEnv();
  // Google first: signing in is the deliberate choice, and made later than
  // any CALDAV_* left over from trying a password.
  if (
    vars.GOOGLE_CLIENT_ID &&
    vars.GOOGLE_CLIENT_SECRET &&
    vars.GOOGLE_REFRESH_TOKEN &&
    vars.GOOGLE_CALENDAR_USER
  ) {
    return {
      kind: "google",
      user: vars.GOOGLE_CALENDAR_USER,
      clientId: vars.GOOGLE_CLIENT_ID,
      clientSecret: vars.GOOGLE_CLIENT_SECRET,
      refreshToken: vars.GOOGLE_REFRESH_TOKEN,
    };
  }
  if (!vars.CALDAV_URL || !vars.CALDAV_USER || !vars.CALDAV_PASSWORD) return null;
  return {
    kind: "basic",
    url: vars.CALDAV_URL,
    user: vars.CALDAV_USER,
    password: vars.CALDAV_PASSWORD,
  };
}

export class CalendarUnavailable extends Error {}
/** No event with that uid in the window anybody asks to change. */
export class CalendarNotFound extends Error {}
/**
 * A change this will not make: a repeating event without saying which part, a
 * series time change that would orphan moved occurrences, or an end before its
 * start.
 */
export class CalendarRefused extends Error {}

/**
 * tsdav's requests, each with a limit. It passes no signal of its own, so a
 * calendar server that accepted the connection and then said nothing held the
 * request that asked, and the assistant's tool call behind it, for as long as
 * the socket lasted.
 */
const davFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, signal: AbortSignal.timeout(20_000) });

async function connect() {
  const config = await calendarConfig();
  if (!config) {
    throw new CalendarUnavailable(
      "the calendar is not set up: sign in with Google under settings, sources, or set CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD",
    );
  }
  if (config.kind === "google") {
    // tsdav trades the refresh token for an access token on every connect,
    // which at a handful of calendar reads an hour is simpler than caching one.
    return createDAVClient({
      serverUrl: GOOGLE_CALDAV_URL,
      credentials: {
        tokenUrl: TOKEN_URL,
        username: config.user,
        refreshToken: config.refreshToken,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
      },
      authMethod: "Oauth",
      defaultAccountType: "caldav",
      fetch: davFetch,
    });
  }
  return createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.user, password: config.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
    fetch: davFetch,
  });
}

/** Events in a window, across every calendar the account has. */
export async function events(start: Date, end: Date): Promise<CalendarEvent[]> {
  const client = await connect();
  const calendars = await client.fetchCalendars();
  const out: CalendarEvent[] = [];
  for (const calendar of calendars) {
    const objects = await client.fetchCalendarObjects({
      calendar,
      timeRange: { start: start.toISOString(), end: end.toISOString() },
      expand: true,
    });
    for (const o of objects) {
      if (typeof o.data !== "string") continue;
      const name = typeof calendar.displayName === "string" ? calendar.displayName : "";
      for (const e of parseIcs(o.data, name)) {
        if (e.end >= start.toISOString() && e.start <= end.toISOString()) out.push(e);
      }
    }
  }
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** Today in the bench's zone, and the next `days` days from now. */
export function window(days: number, now = new Date()): { start: Date; end: Date } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + days);
  return { start, end };
}

export async function today(): Promise<CalendarEvent[]> {
  const { start, end } = window(1);
  return events(start, end);
}

export async function upcoming(days = 7): Promise<CalendarEvent[]> {
  const { start, end } = window(Math.max(1, Math.min(days, 60)));
  return events(start, end);
}

/** Words in the summary, location or description, over the next ninety days. */
export async function search(query: string): Promise<CalendarEvent[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const { start, end } = window(90);
  return (await events(start, end)).filter((e) => {
    const text = `${e.summary} ${e.location ?? ""} ${e.description ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export interface EventFields {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

/** A new event on the account's first calendar, as a file of its own. */
export async function put(event: EventFields): Promise<{ uid: string }> {
  const client = await connect();
  const calendars = await client.fetchCalendars();
  // Google lists the primary calendar under the account's own address, and
  // not necessarily first; a shared or holiday calendar is no place for this.
  const user = (await calendarConfig())?.user;
  const calendar =
    calendars.find((c) => user && c.url.includes(encodeURIComponent(user))) ?? calendars[0];
  if (!calendar) throw new CalendarUnavailable("the account has no calendar to write to");
  const uid = `vk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await client.createCalendarObject({
    calendar,
    filename: `${uid}.ics`,
    iCalString: ics({ ...event, uid }),
  });
  return { uid };
}

const DAY = 86_400_000;

/**
 * The stored file an event lives in, by its UID.
 *
 * Searched over a year back and two ahead rather than everything the account
 * has ever held, which is every event anybody asks to move.
 */
async function find(uid: string) {
  const client = await connect();
  const now = Date.now();
  const timeRange = {
    start: new Date(now - 365 * DAY).toISOString(),
    end: new Date(now + 730 * DAY).toISOString(),
  };
  for (const calendar of await client.fetchCalendars()) {
    for (const object of await client.fetchCalendarObjects({ calendar, timeRange })) {
      if (typeof object.data !== "string") continue;
      if (!parseIcs(object.data).some((e) => e.uid === uid)) continue;
      // A rule, or more than one VEVENT (a series with an occurrence moved):
      // not a single thing to change, so a change to it has to say which part.
      const series =
        /^RRULE[:;]/m.test(object.data) || object.data.split("BEGIN:VEVENT").length > 2;
      return { client, object, data: object.data, series };
    }
  }
  throw new CalendarNotFound(`no event with uid ${uid}`);
}

/**
 * Which part of a repeating event a change means: one occurrence, named by the
 * start it is listed with, or every one. A change to a series that says
 * neither is refused rather than guessed at.
 */
export interface Target {
  occurrence?: string;
  every?: boolean;
}

const WHICH =
  "that event repeats: say which occurrence you mean (its start, as listed), or that it is every one";

/**
 * Change some of one event's fields. Moving only the start keeps the length it
 * had, which is what "move it to three" means; an empty location or
 * description clears it. On a repeating event, `target` says which part.
 */
export async function update(
  uid: string,
  change: Partial<EventFields>,
  target: Target = {},
): Promise<CalendarEvent> {
  const found = await find(uid);
  const { data } = found;
  if (found.series) {
    if (!target.every && !target.occurrence) throw new CalendarRefused(WHICH);
    const listed = target.occurrence ? await listedOccurrence(uid, target.occurrence) : null;
    const next = target.every
      ? seriesUpdate(data, change, target.occurrence)
      : occurrenceUpdate(data, target.occurrence!, change);
    await save(found, next);
    if (target.every || !listed) return firstEvent(next);
    const at = Date.parse(change.start ?? listed.start);
    return parseIcs(next).find((e) => Math.abs(Date.parse(e.start) - at) < MINUTE) ?? listed;
  }
  const current = firstEvent(data);
  const start = change.start ?? current.start;
  const end =
    change.end ??
    (change.start
      ? new Date(
          Date.parse(start) + Date.parse(current.end) - Date.parse(current.start),
        ).toISOString()
      : current.end);
  if (Date.parse(end) <= Date.parse(start)) throw new CalendarRefused("end must be after start");

  const props: Record<string, string> = { DTSTAMP: stamp(new Date().toISOString()) };
  if (change.summary !== undefined) props.SUMMARY = esc(change.summary);
  if (change.location !== undefined) props.LOCATION = esc(change.location);
  if (change.description !== undefined) props.DESCRIPTION = esc(change.description);
  if (change.start !== undefined || change.end !== undefined) {
    Object.assign(props, { DTSTART: stamp(start), DTEND: stamp(end), DURATION: "" });
  }
  const next = edit(data, props);
  await save(found, next);
  return firstEvent(next);
}

/** Write a changed file back over the one it was read from. */
async function save(found: Awaited<ReturnType<typeof find>>, data: string): Promise<void> {
  const res = await found.client.updateCalendarObject({
    calendarObject: { ...found.object, data },
  });
  if (!res.ok) throw new Error(`the calendar server refused the change: ${res.status}`);
}

/**
 * The occurrence of a series that starts at `when`, as the server expands it.
 *
 * Asked before anything is written: an override for a date the rule never
 * produces is an event nobody sees in the app, and an EXDATE for one removes
 * nothing while saying it has.
 */
async function listedOccurrence(uid: string, when: string): Promise<CalendarEvent> {
  const at = instant(when);
  const near = await events(new Date(at - DAY), new Date(at + DAY));
  const hit = near.find((e) => e.uid === uid && Math.abs(Date.parse(e.start) - at) < MINUTE);
  if (!hit) throw new CalendarNotFound(`${uid} has no occurrence starting ${when}`);
  return hit;
}

/**
 * Take an event off the calendar: one occurrence of a series, or the whole of
 * it. Returns what it was, so it can be said.
 */
export async function remove(uid: string, target: Target = {}): Promise<CalendarEvent> {
  const found = await find(uid);
  const removed = await pick(found, uid, target);
  // Before, not after: what is about to go is the only copy there is.
  await keep(uid, found.data);
  if (found.series && !target.every) {
    await save(found, occurrenceRemove(found.data, target.occurrence ?? ""));
    return removed;
  }
  const res = await found.client.deleteCalendarObject({ calendarObject: found.object });
  if (!res.ok) throw new Error(`the calendar server refused the delete: ${res.status}`);
  return removed;
}

/**
 * What a removal would take, without taking it: the card shows this, and a
 * removal that would be refused is refused as the card is filed.
 */
export async function peek(uid: string, target: Target = {}): Promise<CalendarEvent> {
  return pick(await find(uid), uid, target);
}

async function pick(
  found: Awaited<ReturnType<typeof find>>,
  uid: string,
  target: Target,
): Promise<CalendarEvent> {
  if (!found.series || target.every) return firstEvent(found.data);
  if (!target.occurrence) throw new CalendarRefused(WHICH);
  return listedOccurrence(uid, target.occurrence);
}

/** Where a removed event's file is kept. Nothing reads it but a person. */
export function calendarTrashDir(): string {
  return path.join(env.ASSISTANT_DIR, "calendar-trash");
}

/**
 * The event as the server held it, written down before it is removed (A-08).
 *
 * CalDAV has no trash, and a series is years of history and every moved
 * occurrence in one file. This is that file: importing it into any calendar
 * app puts the event back, attendees and alarms included. The whole object is
 * kept even when one occurrence goes, since the file before the change is what
 * undoes the change.
 */
async function keep(uid: string, data: string): Promise<void> {
  await fs.mkdir(calendarTrashDir(), { recursive: true });
  const name = uid.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 100);
  await fs.writeFile(path.join(calendarTrashDir(), `${Date.now()}-${name}.ics`), data);
}

/**
 * The event an object holds. A calendar object is one event, and what came
 * back from the server not parsing into one used to be an undefined that the
 * route then tried to read a start time off.
 */
function firstEvent(ics: string): CalendarEvent {
  const [event] = parseIcs(ics);
  if (!event) throw new Error("the calendar server sent back an event this cannot read");
  return event;
}

/**
 * An event's file with some properties replaced, and the rest (alarms,
 * attendees, whatever the app that made it keeps) left as they were. Only the
 * event's own lines are touched: a VALARM inside it has a DESCRIPTION too. An
 * empty value removes the property.
 */
export function edit(ics: string, props: Record<string, string>): string {
  const lines = ics
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const out: string[] = [];
  // 1 is directly inside the VEVENT; deeper is a component nested in it.
  let depth = 0;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") depth = 1;
    else if (depth === 1 && line === "END:VEVENT") {
      for (const [name, value] of Object.entries(props)) if (value) out.push(`${name}:${value}`);
      depth = 0;
    } else if (depth >= 1 && line.startsWith("BEGIN:")) depth++;
    else if (depth > 1 && line.startsWith("END:")) depth--;
    else if (depth === 1) {
      const cut = line.search(/[;:]/);
      if (cut > 0 && line.slice(0, cut).toUpperCase() in props) continue;
    }
    out.push(line);
  }
  return out.join("\r\n");
}

const esc = (v: string) =>
  v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const stamp = (iso: string) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** An event as the server stores it. UTC times, so no zone is asserted. */
export function ics(e: {
  uid: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//verksted//EN",
    "BEGIN:VEVENT",
    `UID:${e.uid}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(e.start)}`,
    `DTEND:${stamp(e.end)}`,
    `SUMMARY:${esc(e.summary)}`,
    ...(e.location ? [`LOCATION:${esc(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${esc(e.description)}`] : []),
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

// Editing a series in place: one occurrence moved (an override VEVENT with a
// RECURRENCE-ID), one removed (an EXDATE), or every one changed. A
// RECURRENCE-ID or an EXDATE only names an occurrence when it is written in the
// same form as the series' DTSTART (the same zone, or UTC, or a bare date), so
// every time written below is written in the form of the one it sits beside.

const MINUTE = 60_000;

/** "2026-09-22" is that day here, not midnight UTC. */
function instant(when: string): number {
  return /^\d{4}-\d{2}-\d{2}$/.test(when) ? new Date(`${when}T00:00`).getTime() : Date.parse(when);
}

type Prop = { params: string; value: string };
type Form =
  | { kind: "utc" }
  | { kind: "floating" }
  | { kind: "date" }
  | { kind: "zoned"; tzid: string; raw: string };
interface Block {
  from: number;
  to: number;
  lines: string[];
}

/** A file's unfolded lines, and where each top-level VEVENT sits in them. */
function blocksOf(ics: string): { lines: string[]; blocks: Block[] } {
  const lines = ics
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const blocks: Block[] = [];
  let from = -1;
  let depth = 0;
  lines.forEach((line, i) => {
    if (from < 0) {
      if (line === "BEGIN:VEVENT") {
        from = i;
        depth = 1;
      }
      return;
    }
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:") && --depth === 0) {
      blocks.push({ from, to: i, lines: lines.slice(from, i + 1) });
      from = -1;
    }
  });
  return { lines, blocks };
}

function nameOf(line: string): string {
  const cut = line.search(/[;:]/);
  return (cut < 0 ? line : line.slice(0, cut)).toUpperCase();
}

/** A property of the VEVENT itself, not of an alarm inside it. */
function propOf(block: string[], name: string): Prop | null {
  let depth = 0;
  for (const line of block) {
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) depth--;
    else if (depth === 1 && nameOf(line) === name) {
      const colon = line.indexOf(":");
      if (colon < 0) continue;
      const head = line.slice(0, colon);
      const semi = head.indexOf(";");
      return { params: semi < 0 ? "" : head.slice(semi + 1), value: line.slice(colon + 1).trim() };
    }
  }
  return null;
}

/** One VEVENT with some of its own properties dropped and others added. */
function reshape(block: string[], drop: Set<string>, add: string[]): string[] {
  const out: string[] = [];
  let depth = 0;
  for (const line of block) {
    if (line.startsWith("BEGIN:")) depth++;
    else if (line.startsWith("END:")) {
      if (depth === 1) out.push(...add);
      depth--;
    } else if (depth === 1 && drop.has(nameOf(line))) continue;
    out.push(line);
  }
  return out;
}

/** The file again: some VEVENTs replaced (null drops one), new ones after the last. */
function rejoin(
  lines: string[],
  blocks: Block[],
  replaced: Map<Block, string[] | null>,
  added: string[] = [],
): string {
  const out: string[] = [];
  let i = 0;
  for (const b of blocks) {
    out.push(...lines.slice(i, b.from));
    const next = replaced.has(b) ? replaced.get(b) : b.lines;
    if (next) out.push(...next);
    i = b.to + 1;
    if (b === blocks[blocks.length - 1]) out.push(...added);
  }
  out.push(...lines.slice(i));
  return out.join("\r\n");
}

function formOf(p: Prop): Form {
  if (/VALUE=DATE(?!-TIME)/i.test(p.params) || /^\d{8}$/.test(p.value)) return { kind: "date" };
  const tz = /(?:^|;)TZID=("[^"]*"|[^;]*)/i.exec(p.params);
  if (tz) {
    const raw = tz[1] ?? "";
    const tzid = raw.replace(/^"|"$/g, "");
    try {
      Intl.DateTimeFormat("en-CA", { timeZone: tzid });
    } catch {
      throw new CalendarRefused(
        `its time zone, ${tzid}, is not one this can write; change it in the calendar app`,
      );
    }
    return { kind: "zoned", tzid, raw };
  }
  return /Z$/i.test(p.value) ? { kind: "utc" } : { kind: "floating" };
}

/** An instant's wall-clock reading in a form's zone, as though that reading were UTC. */
function wallOf(ms: number, form: Form): number {
  if (form.kind === "utc") return ms;
  const parts = Intl.DateTimeFormat("en-CA", {
    timeZone: form.kind === "zoned" ? form.tzid : undefined,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
    part("second"),
  );
}

/** The instant a wall-clock reading names in a form's zone; twice, for one near an offset change. */
function fromWall(wall: number, form: Form): number {
  if (form.kind === "utc") return wall;
  let t = wall - (wallOf(wall, form) - wall);
  t = wall - (wallOf(t, form) - t);
  return t;
}

function readIn(p: Prop): number {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?Z?$/i.exec(p.value);
  if (!m)
    throw new CalendarRefused(`cannot read the date ${p.value}; change it in the calendar app`);
  // The first three groups are not optional, so they are there when m is.
  const [, y = "", mo = "", d = "", h = "0", mi = "0", s = "0"] = m;
  return fromWall(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s), formOf(p));
}

/** An instant as the `;params:value` tail of a property, in the given form. */
function valueIn(ms: number, form: Form): string {
  const digits = new Date(wallOf(ms, form)).toISOString().replace(/[-:]/g, "").slice(0, 15);
  if (form.kind === "utc") return `:${digits}Z`;
  if (form.kind === "date") return `;VALUE=DATE:${digits.slice(0, 8)}`;
  if (form.kind === "zoned") return `;TZID=${form.raw}:${digits}`;
  return `:${digits}`;
}

/** An RFC 5545 duration, "PT30M" or "P1D", in milliseconds. */
function durationMs(v: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(v);
  if (!m) return null;
  const [, sign, w = "0", d = "0", h = "0", mi = "0", s = "0"] = m;
  const ms = (((+w * 7 + +d) * 24 + +h) * 60 + +mi) * 60_000 + +s * 1000;
  return sign === "-" ? -ms : ms;
}

function lengthOf(block: string[]): number {
  const start = propOf(block, "DTSTART");
  const end = propOf(block, "DTEND");
  if (start && end) return readIn(end) - readIn(start);
  const duration = propOf(block, "DURATION");
  const ms = duration ? durationMs(duration.value) : null;
  if (ms) return ms;
  return start && formOf(start).kind === "date" ? DAY : 3_600_000;
}

/** SUMMARY, LOCATION and DESCRIPTION as a change sets them: given replaces, empty removes. */
function fieldLines(change: Partial<EventFields>): { drop: string[]; add: string[] } {
  const drop: string[] = [];
  const add: string[] = [];
  const names = [
    ["summary", "SUMMARY"],
    ["location", "LOCATION"],
    ["description", "DESCRIPTION"],
  ] as const;
  for (const [key, name] of names) {
    const value = change[key];
    if (value === undefined) continue;
    drop.push(name);
    if (value) add.push(`${name}:${esc(value)}`);
  }
  return { drop, add };
}

function masterOf(blocks: Block[]): Block {
  const master = blocks.find((b) => propOf(b.lines, "RRULE") && !propOf(b.lines, "RECURRENCE-ID"));
  if (!master || !propOf(master.lines, "DTSTART")) {
    throw new CalendarRefused(
      "that event repeats in a way this cannot edit; change it in the calendar app",
    );
  }
  return master;
}

/** The override standing for an occurrence: by the start it replaced, or the one it has now. */
function overrideAt(blocks: Block[], at: number): Block | undefined {
  const near = (p: Prop | null) => p !== null && Math.abs(readIn(p) - at) < MINUTE;
  return blocks.find((b) => {
    const rid = propOf(b.lines, "RECURRENCE-ID");
    return rid !== null && (near(rid) || near(propOf(b.lines, "DTSTART")));
  });
}

/** What only a series carries, and what an override writes for itself. */
const SERIES_ONLY = ["RRULE", "RDATE", "EXDATE", "EXRULE", "RECURRENCE-ID"];
const TIMES = ["DTSTART", "DTEND", "DURATION", "DTSTAMP"];

/**
 * Move or edit one occurrence of a series. One already moved is edited where it
 * stands; otherwise the series' own VEVENT is copied, rule and all left behind,
 * into an override for that one date, alarms and attendees with it.
 */
export function occurrenceUpdate(
  ics: string,
  occurrence: string,
  change: Partial<EventFields>,
  now = new Date(),
): string {
  const { lines, blocks } = blocksOf(ics);
  const master = masterOf(blocks);
  const form = formOf(propOf(master.lines, "DTSTART")!);
  const at = instant(occurrence);
  const override = overrideAt(blocks, at);
  const own = override ? formOf(propOf(override.lines, "DTSTART")!) : form;
  const from = override ? readIn(propOf(override.lines, "DTSTART")!) : at;
  const start = change.start !== undefined ? Date.parse(change.start) : from;
  const end =
    change.end !== undefined
      ? Date.parse(change.end)
      : start + lengthOf((override ?? master).lines);
  if (end <= start) throw new CalendarRefused("end must be after start");

  const fields = fieldLines(change);
  const add = [
    `DTSTART${valueIn(start, own)}`,
    `DTEND${valueIn(end, own)}`,
    `DTSTAMP:${stamp(now.toISOString())}`,
    ...fields.add,
  ];
  const drop = new Set([...TIMES, ...fields.drop]);
  if (override) {
    return rejoin(
      lines,
      blocks,
      new Map<Block, string[] | null>([[override, reshape(override.lines, drop, add)]]),
    );
  }
  const copy = reshape(master.lines, new Set([...drop, ...SERIES_ONLY]), [
    `RECURRENCE-ID${valueIn(at, form)}`,
    ...add,
  ]);
  return rejoin(lines, blocks, new Map(), copy);
}

/**
 * Take one occurrence out of a series: an EXDATE on the series for the start the
 * rule gave it, and its override gone if it had been moved.
 */
export function occurrenceRemove(ics: string, occurrence: string): string {
  const { lines, blocks } = blocksOf(ics);
  const master = masterOf(blocks);
  const form = formOf(propOf(master.lines, "DTSTART")!);
  const override = overrideAt(blocks, instant(occurrence));
  const original = override
    ? readIn(propOf(override.lines, "RECURRENCE-ID")!)
    : instant(occurrence);
  const replaced = new Map<Block, string[] | null>([
    [master, reshape(master.lines, new Set(), [`EXDATE${valueIn(original, form)}`])],
  ]);
  if (override) replaced.set(override, null);
  return rejoin(lines, blocks, replaced);
}

/**
 * Change every occurrence. Words reach the series and each moved occurrence
 * alike. A new time moves the series by the wall clock in its own zone, so a
 * weekly 10:00 made 11:00 is 11:00 in winter too; it needs the occurrence the new
 * time was said about, and is refused once any occurrence was moved or removed,
 * since their RECURRENCE-IDs and EXDATEs name starts the series would no longer
 * have.
 */
export function seriesUpdate(
  ics: string,
  change: Partial<EventFields>,
  occurrence?: string,
  now = new Date(),
): string {
  const { lines, blocks } = blocksOf(ics);
  const master = masterOf(blocks);
  const fields = fieldLines(change);
  const stamped = `DTSTAMP:${stamp(now.toISOString())}`;

  if (change.start === undefined && change.end === undefined) {
    const drop = new Set(["DTSTAMP", ...fields.drop]);
    return rejoin(
      lines,
      blocks,
      new Map<Block, string[] | null>(
        blocks.map((b) => [b, reshape(b.lines, drop, [stamped, ...fields.add])]),
      ),
    );
  }
  if (blocks.some((b) => propOf(b.lines, "RECURRENCE-ID")) || propOf(master.lines, "EXDATE")) {
    throw new CalendarRefused(
      "some occurrences of that series were already moved or removed, and moving every one would cut them loose; move occurrences one at a time, or change the series in the calendar app",
    );
  }
  if (occurrence === undefined) {
    throw new CalendarRefused(
      "to move every occurrence, say which one the new time is for, so the series moves by the same amount",
    );
  }

  const first = propOf(master.lines, "DTSTART")!;
  const form = formOf(first);
  const at = instant(occurrence);
  const newStart = change.start !== undefined ? Date.parse(change.start) : at;
  const newEnd =
    change.end !== undefined ? Date.parse(change.end) : newStart + lengthOf(master.lines);
  if (newEnd <= newStart) throw new CalendarRefused("end must be after start");
  const start = fromWall(
    wallOf(readIn(first), form) + wallOf(newStart, form) - wallOf(at, form),
    form,
  );
  const add = [
    `DTSTART${valueIn(start, form)}`,
    `DTEND${valueIn(start + newEnd - newStart, form)}`,
    stamped,
    ...fields.add,
  ];
  return rejoin(
    lines,
    blocks,
    new Map<Block, string[] | null>([
      [master, reshape(master.lines, new Set([...TIMES, ...fields.drop]), add)],
    ]),
  );
}

/**
 * The parts of an iCalendar file this needs, without a library: unfold the
 * lines, walk each VEVENT, read six properties. Dates come in three shapes
 * and go out as ISO strings; a floating or zoned local time is read in the
 * process's own zone, which the image sets to the bench's.
 */
export function parseIcs(ics: string, calendar = ""): CalendarEvent[] {
  const lines = ics
    .replace(/\r\n/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n");
  const out: CalendarEvent[] = [];
  let cur: Record<string, { value: string; params: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT") {
      if (cur) {
        const e = eventOf(cur, calendar);
        if (e) out.push(e);
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const head = line.slice(0, colon);
    const semi = head.indexOf(";");
    const name = (semi < 0 ? head : head.slice(0, semi)).toUpperCase();
    const params = semi < 0 ? "" : head.slice(semi + 1);
    // A recurrence expanded by the server repeats UID with its own start; the
    // first of each property wins, which is what an unexpanded file wants too.
    if (!(name in cur)) cur[name] = { value: unescape(line.slice(colon + 1)), params };
  }
  return out;
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

function eventOf(
  p: Record<string, { value: string; params: string }>,
  calendar: string,
): CalendarEvent | null {
  const start = p.DTSTART;
  if (!start) return null;
  const allDay = /VALUE=DATE(?!-TIME)/i.test(start.params) || /^\d{8}$/.test(start.value);
  const startIso = toIso(start.value, allDay);
  if (!startIso) return null;
  let endIso = p.DTEND ? toIso(p.DTEND.value, allDay) : null;
  if (!endIso) {
    const d = new Date(startIso);
    if (allDay) d.setDate(d.getDate() + 1);
    else d.setHours(d.getHours() + 1);
    endIso = d.toISOString();
  }
  return {
    uid: p.UID?.value ?? `${startIso}-${p.SUMMARY?.value ?? ""}`,
    summary: p.SUMMARY?.value?.trim() || "(untitled)",
    start: startIso,
    end: endIso,
    allDay,
    location: p.LOCATION?.value?.trim() || null,
    url:
      p.URL?.value?.trim() || linkIn(p.DESCRIPTION?.value ?? "") || linkIn(p.LOCATION?.value ?? ""),
    description: p.DESCRIPTION?.value?.trim() || null,
    calendar,
    // A rule on an unexpanded series, or the RECURRENCE-ID the server puts on
    // each occurrence it expands.
    ...("RRULE" in p || "RECURRENCE-ID" in p ? { recurring: true } : {}),
  };
}

/** A video link buried in a description is the one people tap. */
function linkIn(text: string): string | null {
  const m = /https?:\/\/[^\s<>"']+/.exec(text);
  return m ? m[0] : null;
}

/** 20260830, 20260830T100000 and 20260830T100000Z, as ISO. */
export function toIso(value: string, allDay: boolean): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", s = "00", z] = m;
  if (allDay || !/T/.test(value)) {
    return new Date(Number(y), Number(mo) - 1, Number(d)).toISOString();
  }
  if (z) return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s),
  ).toISOString();
}
