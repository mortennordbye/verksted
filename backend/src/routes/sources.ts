import type { FastifyInstance } from "fastify";
import type { CalendarEvent, MailMessage, MailSummary, SourceStatus } from "../../../shared/api.js";
import * as calendar from "../calendar.js";
import * as mail from "../mail.js";

/**
 * Mail and calendar, read.
 *
 * Both answer 503 with a sentence when they are not set up, so a tool or a
 * screen can tell "no mail here" from "mail broke", and 502 when the server
 * on the other side would not answer. Nothing here writes.
 */
export default async function sourceRoutes(app: FastifyInstance) {
  app.get("/api/sources", async (): Promise<SourceStatus> => ({
    mail: (await mail.mailConfig()) !== null,
    calendar: (await calendar.calendarConfig()) !== null,
  }));

  const guard = async <T>(
    fn: () => Promise<T>,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    what: string,
  ): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof mail.MailUnavailable || err instanceof calendar.CalendarUnavailable) {
        return reply.code(503).send({ error: err.message });
      }
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
}
