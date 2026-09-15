import type { FastifyInstance } from "fastify";
import type {
  CalendarEvent,
  GmailLabel,
  GmailRule,
  MailFolder,
  MailMessage,
  MailSummary,
  SourceStatus,
} from "../../../shared/api.js";
import * as calendar from "../calendar.js";
import * as docs from "../docs.js";
import * as gmail from "../gmail.js";
import * as mail from "../mail.js";

/**
 * Mail and calendar, read.
 *
 * Both answer 503 with a sentence when they are not set up, so a tool or a
 * screen can tell "no mail here" from "mail broke", and 502 when the server
 * on the other side would not answer.
 *
 * Mail's one write here is a move between mailboxes, undone by moving back.
 * The Gmail-only label and filter routes (gmail.ts) write more lastingly — a
 * filter acts on every mail from then on — which is why creating or deleting
 * one is chair-only at the tool layer, not something enforced here.
 */
/**
 * Where a source lives on the web, told from the settings it already has.
 *
 * Only the providers whose web app is a fixed address: a host we do not
 * recognise gets no link rather than a guess, and the screen sends that one
 * to settings instead. The account goes along where the provider takes it, so
 * a browser signed in to two Google accounts opens the right one.
 */
export function sourceLinks(
  mailbox: { host: string; user: string } | null,
  cal: calendar.CalendarConfig | null,
): SourceStatus["links"] {
  const links: SourceStatus["links"] = { github: "https://github.com/notifications" };
  const host = mailbox?.host.toLowerCase() ?? "";
  if (mailbox && /(^|\.)(gmail|googlemail)\.com$/.test(host)) {
    links.mail = `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox.user)}`;
  } else if (/(^|\.)(outlook\.office365|office365|outlook)\.com$/.test(host)) {
    links.mail = "https://outlook.office.com/mail/";
  } else if (/(^|\.)mail\.me\.com$/.test(host)) {
    links.mail = "https://www.icloud.com/mail";
  } else if (/(^|\.)fastmail\.com$/.test(host)) {
    links.mail = "https://app.fastmail.com/mail/";
  }
  if (cal?.kind === "google") {
    links.calendar = `https://calendar.google.com/calendar/?authuser=${encodeURIComponent(cal.user)}`;
  } else if (cal?.kind === "basic") {
    let calHost = "";
    try {
      calHost = new URL(cal.url).hostname.toLowerCase();
    } catch {
      // A CALDAV_URL that is not a URL names no page.
    }
    if (/(^|\.)icloud\.com$/.test(calHost)) links.calendar = "https://www.icloud.com/calendar";
    else if (/(^|\.)fastmail\.com$/.test(calHost)) {
      links.calendar = "https://app.fastmail.com/calendar/";
    }
  }
  return links;
}

export default async function sourceRoutes(app: FastifyInstance) {
  app.get("/api/sources", async (): Promise<SourceStatus> => {
    const [mailbox, cal] = await Promise.all([mail.mailConfig(), calendar.calendarConfig()]);
    return {
      mail: mailbox !== null,
      calendar: cal !== null,
      docs: await docs.configured(),
      links: sourceLinks(mailbox, cal),
    };
  });

  const guard = async <T>(
    fn: () => Promise<T>,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    what: string,
  ): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof calendar.CalendarNotFound) {
        return reply.code(404).send({ error: err.message });
      }
      if (err instanceof calendar.CalendarRefused) {
        return reply.code(409).send({ error: err.message });
      }
      if (
        err instanceof mail.MailUnavailable ||
        err instanceof calendar.CalendarUnavailable ||
        err instanceof gmail.GmailUnavailable
      ) {
        return reply.code(503).send({ error: err.message });
      }
      // A folder that is not there is the caller's mistake, and the sentence
      // saying so is the whole of how a model corrects itself.
      if (err instanceof mail.MailDenied || err instanceof gmail.RuleRefused) {
        return reply.code(400).send({ error: err.message });
      }
      // Signed in, but without the Gmail scopes: distinct from "not signed in"
      // at all, since the fix is reconnecting rather than setting anything up.
      if (err instanceof gmail.GmailDenied) return reply.code(403).send({ error: err.message });
      app.log.warn(err, `${what} failed`);
      return reply.code(502).send({ error: `${what} could not be read` });
    }
  };

  app.get("/api/mail", (_req, reply) => guard<MailSummary[]>(() => mail.recent(), reply, "mail"));

  app.get<{ Querystring: { q: string } }>(
    "/api/mail/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: { q: { type: "string", minLength: 2, maxLength: 200 } },
        },
      },
    },
    (req, reply) => guard<MailSummary[]>(() => mail.search(req.query.q), reply, "mail search"),
  );

  app.get<{ Params: { uid: string } }>(
    "/api/mail/:uid",
    {
      schema: {
        params: {
          type: "object",
          properties: { uid: { type: "string", pattern: "^[0-9]{1,12}$" } },
        },
      },
    },
    (req, reply) =>
      guard<MailMessage | null>(
        async () => {
          const m = await mail.read(Number(req.params.uid));
          return m ?? reply.code(404).send({ error: "no such message" });
        },
        reply,
        "mail",
      ),
  );

  app.get("/api/mail/folders", (_req, reply) =>
    guard<MailFolder[]>(() => mail.folders(), reply, "mail folders"),
  );

  app.post<{ Body: { uids: number[]; to: string } }>(
    "/api/mail/move",
    {
      schema: {
        body: {
          type: "object",
          required: ["uids", "to"],
          additionalProperties: false,
          properties: {
            uids: {
              type: "array",
              minItems: 1,
              maxItems: mail.MAX_MOVE,
              items: { type: "integer", minimum: 1 },
            },
            to: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    (req, reply) =>
      guard<{ moved: number }>(
        async () => ({ moved: await mail.move(req.body.uids, req.body.to) }),
        reply,
        "mail move",
      ),
  );

  // Gmail's labels and filters, over its API rather than IMAP — see gmail.ts.
  app.get("/api/mail/labels", (_req, reply) =>
    guard<GmailLabel[]>(() => gmail.labels(), reply, "gmail labels"),
  );

  app.post<{ Body: gmail.RelabelFields }>(
    "/api/mail/relabel",
    {
      schema: {
        body: {
          type: "object",
          required: ["query"],
          additionalProperties: false,
          properties: {
            query: { type: "string", minLength: 1, maxLength: 500 },
            add: {
              type: "array",
              maxItems: 10,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
            remove: {
              type: "array",
              maxItems: 10,
              items: { type: "string", minLength: 1, maxLength: 200 },
            },
          },
        },
      },
    },
    (req, reply) =>
      guard<{ changed: number }>(
        async () => ({ changed: await gmail.relabel(req.body) }),
        reply,
        "gmail relabel",
      ),
  );

  app.get("/api/mail/rules", (_req, reply) =>
    guard<GmailRule[]>(() => gmail.rules(), reply, "gmail rules"),
  );

  app.post<{ Body: gmail.RuleFields }>(
    "/api/mail/rules",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            from: { type: "string", maxLength: 200 },
            subject: { type: "string", maxLength: 200 },
            query: { type: "string", maxLength: 500 },
            label: { type: "string", minLength: 1, maxLength: 200 },
            archive: { type: "boolean" },
            markRead: { type: "boolean" },
          },
        },
      },
    },
    (req, reply) => guard<GmailRule>(() => gmail.createRule(req.body), reply, "gmail rule create"),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/mail/rules/:id",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string", minLength: 1, maxLength: 200 } },
        },
      },
    },
    (req, reply) =>
      guard<{ id: string }>(
        async () => {
          await gmail.deleteRule(req.params.id);
          return { id: req.params.id };
        },
        reply,
        "gmail rule delete",
      ),
  );

  app.get("/api/calendar/today", (_req, reply) =>
    guard<CalendarEvent[]>(() => calendar.today(), reply, "calendar"),
  );

  app.get<{ Querystring: { days?: number } }>(
    "/api/calendar/upcoming",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { days: { type: "integer", minimum: 1, maximum: 60 } },
        },
      },
    },
    (req, reply) =>
      guard<CalendarEvent[]>(() => calendar.upcoming(req.query.days ?? 7), reply, "calendar"),
  );

  app.get<{ Querystring: { q: string } }>(
    "/api/calendar/search",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["q"],
          additionalProperties: false,
          properties: { q: { type: "string", minLength: 2, maxLength: 200 } },
        },
      },
    },
    (req, reply) =>
      guard<CalendarEvent[]>(() => calendar.search(req.query.q), reply, "calendar search"),
  );

  /** A month grid's six weeks, or any window up to about that. */
  app.get<{ Querystring: { start: string; end: string } }>(
    "/api/calendar/range",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["start", "end"],
          additionalProperties: false,
          properties: {
            start: { type: "string", maxLength: 40 },
            end: { type: "string", maxLength: 40 },
          },
        },
      },
    },
    (req, reply) => {
      const start = Date.parse(req.query.start);
      const end = Date.parse(req.query.end);
      if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
        return reply.code(400).send({ error: "start and end must be dates, end after start" });
      }
      if (end - start > 62 * 86_400_000) {
        return reply.code(400).send({ error: "at most 62 days at a time" });
      }
      return guard<CalendarEvent[]>(
        () => calendar.events(new Date(start), new Date(end)),
        reply,
        "calendar",
      );
    },
  );

  // Writes. There is no undo on the server, so these are for when the person
  // said to do it: the chair's calendar tools call them, and an event it only
  // thinks of itself still goes through a proposal card.
  const eventProps = {
    summary: { type: "string", minLength: 1, maxLength: 300 },
    // Checked with Date.parse below rather than format: date-time, which
    // refuses the offset-less local time a person's "15:50" arrives as.
    start: { type: "string", minLength: 1, maxLength: 40 },
    end: { type: "string", minLength: 1, maxLength: 40 },
    location: { type: "string", maxLength: 300 },
    description: { type: "string", maxLength: 2000 },
  };
  const uidParam = {
    type: "object",
    required: ["uid"],
    additionalProperties: false,
    // A UID is only ever compared against what the server holds, never put in
    // a path or a command; printable ASCII is every one seen in the wild.
    properties: { uid: { type: "string", pattern: "^[\\x21-\\x7e]{1,500}$" } },
  };
  /** Dates as ISO, or a sentence saying why not. */
  const badDates = (start?: string, end?: string): string | null => {
    if ([start, end].some((d) => d !== undefined && Number.isNaN(Date.parse(d)))) {
      return "start and end must be dates";
    }
    if (start && end && Date.parse(end) <= Date.parse(start)) return "end must be after start";
    return null;
  };
  const iso = (d?: string) => (d === undefined ? undefined : new Date(d).toISOString());
  // Which part of a repeating event a change means (calendar.Target). Kept as
  // it was sent: "2026-09-22" is a day here, which toISOString would make UTC.
  const targetProps = {
    occurrence: { type: "string", minLength: 1, maxLength: 40 },
    every: { type: "boolean" },
  };
  const badOccurrence = (when?: string): string | null =>
    when !== undefined && Number.isNaN(Date.parse(when)) ? "occurrence must be a date" : null;

  app.post<{ Body: calendar.EventFields }>(
    "/api/calendar/events",
    {
      schema: {
        body: {
          type: "object",
          required: ["summary", "start", "end"],
          additionalProperties: false,
          properties: eventProps,
        },
      },
    },
    (req, reply) => {
      const bad = badDates(req.body.start, req.body.end);
      if (bad) return reply.code(400).send({ error: bad });
      return guard<{ uid: string }>(
        () => calendar.put({ ...req.body, start: iso(req.body.start)!, end: iso(req.body.end)! }),
        reply,
        "calendar add",
      );
    },
  );

  app.patch<{
    Params: { uid: string };
    Body: Partial<calendar.EventFields> & calendar.Target;
  }>(
    "/api/calendar/events/:uid",
    {
      schema: {
        params: uidParam,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: { ...eventProps, ...targetProps },
        },
      },
    },
    (req, reply) => {
      const { occurrence, every, ...fields } = req.body;
      if (!Object.keys(fields).length) return reply.code(400).send({ error: "nothing to change" });
      const bad = badDates(fields.start, fields.end) ?? badOccurrence(occurrence);
      if (bad) return reply.code(400).send({ error: bad });
      const change = { ...fields, start: iso(fields.start), end: iso(fields.end) };
      if (change.start === undefined) delete change.start;
      if (change.end === undefined) delete change.end;
      return guard<CalendarEvent>(
        () => calendar.update(req.params.uid, change, { occurrence, every }),
        reply,
        "calendar update",
      );
    },
  );

  app.delete<{ Params: { uid: string }; Querystring: calendar.Target }>(
    "/api/calendar/events/:uid",
    {
      schema: {
        params: uidParam,
        querystring: { type: "object", additionalProperties: false, properties: targetProps },
      },
    },
    (req, reply) => {
      const { occurrence, every } = req.query;
      if (occurrence !== undefined && every) {
        return reply.code(400).send({ error: "either one occurrence or every one, not both" });
      }
      const bad = badOccurrence(occurrence);
      if (bad) return reply.code(400).send({ error: bad });
      return guard<CalendarEvent>(
        () => calendar.remove(req.params.uid, { occurrence, every }),
        reply,
        "calendar delete",
      );
    },
  );
}
