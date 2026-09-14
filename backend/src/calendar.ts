import { createDAVClient } from "tsdav";
import type { CalendarEvent } from "../../shared/api.js";
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
 * the person asked for it or tapped a card; a recurring series is refused,
 * since "move it" could mean one Tuesday or every one of them.
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
/** A change this will not make: a recurring series, or an end before its start. */
export class CalendarRefused extends Error {}

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
    });
  }
  return createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.user, password: config.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
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
      // One VEVENT and no rule: a series, or a series with one occurrence
      // moved, is not a single thing to change.
      if (/^RRULE[:;]/m.test(object.data) || object.data.split("BEGIN:VEVENT").length > 2) {
        throw new CalendarRefused(
          "that is a recurring event; change it in the calendar app, where one occurrence and the series are told apart",
        );
      }
      return { client, object, data: object.data };
    }
  }
  throw new CalendarNotFound(`no event with uid ${uid}`);
}

/**
 * Change some of one event's fields. Moving only the start keeps the length it
 * had, which is what "move it to three" means; an empty location or
 * description clears it.
 */
export async function update(uid: string, change: Partial<EventFields>): Promise<CalendarEvent> {
  const { client, object, data } = await find(uid);
  const [current] = parseIcs(data);
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
  const res = await client.updateCalendarObject({ calendarObject: { ...object, data: next } });
  if (!res.ok) throw new Error(`the calendar server refused the change: ${res.status}`);
  return parseIcs(next)[0];
}

/** Take one event off the calendar. Returns what it was, so it can be said. */
export async function remove(uid: string): Promise<CalendarEvent> {
  const { client, object, data } = await find(uid);
  const res = await client.deleteCalendarObject({ calendarObject: object });
  if (!res.ok) throw new Error(`the calendar server refused the delete: ${res.status}`);
  return parseIcs(data)[0];
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
