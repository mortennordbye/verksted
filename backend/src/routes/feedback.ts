import type { FastifyInstance } from "fastify";
import type { Feedback } from "../../../shared/api.js";
import * as feedback from "../feedback-store.js";
import { MAX_TEXT } from "../feedback-store.js";
import { getSession } from "../sessions-store.js";

/**
 * What the agents say is missing, filed from inside a session by `vk feedback`.
 *
 * The body is text/plain rather than JSON because the client is a POSIX shell
 * script: `vk` would otherwise have to escape arbitrary prose into a JSON
 * string, which is exactly the kind of quoting nobody gets right in sh. The
 * note itself is the whole body, so there is nothing to escape.
 *
 * The session it came from is a query parameter, and it is a claim rather than
 * proof — anything on the pod can post here, and there is no in-app auth to
 * check it against (WireGuard is the boundary). It is used for provenance only:
 * to show which repo a note came out of, never to grant anything.
 */
export default async function feedbackRoutes(app: FastifyInstance) {
  app.get("/api/feedback", async (): Promise<{ feedback: Feedback[] }> => ({
    feedback: await feedback.list(),
  }));

  app.post<{ Querystring: { session?: string }; Body: string }>(
    "/api/feedback",
    {
      // A note is a sentence or two. Anything bigger is a design document that
      // wants a different home, and this is a body no one authenticated sent.
      bodyLimit: 8 * 1024,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { session: { type: "string", maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      // Anything but text/plain arrives parsed into an object, and stringifying
      // one files "[object Object]" as somebody's note.
      const text = typeof req.body === "string" ? req.body.trim() : "";
      if (!text) return reply.code(400).send({ error: "feedback text is empty" });
      if (text.length > MAX_TEXT) {
        return reply.code(400).send({ error: `feedback must be ${MAX_TEXT} characters or fewer` });
      }
      // The repo and agent are read off the session rather than taken from the
      // caller: they are facts verksted already knows, and a note is worth more
      // when the context on it is not self-reported.
      const session = req.query.session ? await getSession(req.query.session) : null;
      return reply.code(201).send(
        await feedback.add({
          text,
          session: session?.id ?? null,
          project: session?.project ?? null,
          agent: session?.agent ?? null,
        }),
      );
    },
  );

  app.delete<{ Params: { id: string } }>("/api/feedback/:id", async (req, reply) => {
    if (!(await feedback.remove(req.params.id))) {
      return reply.code(404).send({ error: "not found" });
    }
    return { id: req.params.id };
  });
}
