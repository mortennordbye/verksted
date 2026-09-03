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
}
