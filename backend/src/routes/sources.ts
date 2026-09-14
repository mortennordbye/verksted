import type { FastifyInstance } from "fastify";
import type {
  CalendarEvent,
  MailFolder,
  MailMessage,
  MailSummary,
  SourceStatus,
} from "../../../shared/api.js";
import * as calendar from "../calendar.js";
import * as docs from "../docs.js";
import * as mail from "../mail.js";

/**
 * Mail and calendar, read.
 *
 * Both answer 503 with a sentence when they are not set up, so a tool or a
 * screen can tell "no mail here" from "mail broke", and 502 when the server
 * on the other side would not answer.
 *
 * One thing here writes: a move between mailboxes, which is undone by moving
 * back. A destination the server did not list is a 400 rather than a mailbox
 * created on the way past.
 */
export default async function sourceRoutes(app: FastifyInstance) {
  app.get("/api/sources", async (): Promise<SourceStatus> => ({
    mail: (await mail.mailConfig()) !== null,
    calendar: (await calendar.calendarConfig()) !== null,
    docs: await docs.configured(),
  }));

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
      if (err instanceof mail.MailUnavailable || err instanceof calendar.CalendarUnavailable) {
        return reply.code(503).send({ error: err.message });
      }
      // A folder that is not there is the caller's mistake, and the sentence
      // saying so is the whole of how a model corrects itself.
      if (err instanceof mail.MailDenied) return reply.code(400).send({ error: err.message });
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

  app.patch<{ Params: { uid: string }; Body: Partial<calendar.EventFields> }>(
    "/api/calendar/events/:uid",
    {
      schema: {
        params: uidParam,
        body: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties: eventProps,
        },
      },
    },
    (req, reply) => {
      const bad = badDates(req.body.start, req.body.end);
      if (bad) return reply.code(400).send({ error: bad });
      const change = { ...req.body, start: iso(req.body.start), end: iso(req.body.end) };
      if (change.start === undefined) delete change.start;
      if (change.end === undefined) delete change.end;
      return guard<CalendarEvent>(
        () => calendar.update(req.params.uid, change),
        reply,
        "calendar update",
      );
    },
  );

  app.delete<{ Params: { uid: string } }>(
    "/api/calendar/events/:uid",
    { schema: { params: uidParam } },
    (req, reply) =>
      guard<CalendarEvent>(() => calendar.remove(req.params.uid), reply, "calendar delete"),
  );
}
