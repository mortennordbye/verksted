import { createDAVClient } from "tsdav";
import type { CalendarEvent } from "../../shared/api.js";
import { sourceEnv } from "./settings-store.js";

/**
 * The calendar, read over CalDAV.
 *
 * Google, iCloud and Fastmail all expose it; the credential is the same shape
 * as mail's and lives in the same place. Read-only: the two verbs used are
 * PROPFIND and REPORT, and the server is asked to expand recurrences inside
 * the window so a weekly meeting is a row per week rather than a rule to
 * interpret here. Writes come later, as proposals.
 */
export interface CalendarConfig {
  url: string;
  user: string;
  password: string;
}

export async function calendarConfig(): Promise<CalendarConfig | null> {
  const vars = await sourceEnv();
  if (!vars.CALDAV_URL || !vars.CALDAV_USER || !vars.CALDAV_PASSWORD) return null;
  return { url: vars.CALDAV_URL, user: vars.CALDAV_USER, password: vars.CALDAV_PASSWORD };
}

export class CalendarUnavailable extends Error {}

/** Events in a window, across every calendar the account has. */
export async function events(start: Date, end: Date): Promise<CalendarEvent[]> {
  const config = await calendarConfig();
  if (!config) {
    throw new CalendarUnavailable(
      "the calendar is not set up: CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD",
    );
  }
  const client = await createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.user, password: config.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
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

/**
 * The one write, which only a tapped proposal reaches: a new event on the
 * account's first calendar, as a file of its own. Nothing here edits or
 * deletes what is there.
 */
export async function put(event: {
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}): Promise<{ uid: string }> {
  const config = await calendarConfig();
  if (!config) {
    throw new CalendarUnavailable(
      "the calendar is not set up: CALDAV_URL, CALDAV_USER, CALDAV_PASSWORD",
    );
  }
  const client = await createDAVClient({
    serverUrl: config.url,
    credentials: { username: config.user, password: config.password },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  const [calendar] = await client.fetchCalendars();
  if (!calendar) throw new CalendarUnavailable("the account has no calendar to write to");
  const uid = `vk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await client.createCalendarObject({
    calendar,
    filename: `${uid}.ics`,
    iCalString: ics({ ...event, uid }),
  });
  return { uid };
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
