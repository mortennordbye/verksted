import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as feed from "../feed-store.js";
import { getSession } from "../sessions-store.js";

/** A note, not a design document: the point is the one thing that was missing. */
export const MAX_TEXT = 1000;

/**
 * What the agents say is missing, filed from inside a session by `vk feedback`.
 *
 * The agents are the only ones who find out what verksted cannot do, at the
 * moment it stops them, and until now that discovery went into a transcript
 * nobody reads. A note lands in the feed as a bench item — the bench's own
 * source, which is what a note about the bench is — so it is triaged, shown and
 * dismissed by everything the feed already does, rather than by a second inbox
 * of its own.
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
      // The text is the id, so the same complaint filed on Monday and again on
      // Thursday is one item — every session is told this command exists, and a
      // queue that repeats itself is one nobody reads. The version is constant
      // for the same reason: re-filing must not bring back a note you dismissed.
      const { item } = await feed.upsert({
        id: `bench:feedback:${createHash("sha256").update(text).digest("hex").slice(0, 12)}`,
        source: "bench",
        at: new Date().toISOString(),
        title: `the bench is missing something: ${text.split("\n")[0].slice(0, 120)}`,
        detail: [text, session && `filed by ${session.agent} in ${session.project}`]
          .filter(Boolean)
          .join("\n"),
        link: session ? `/s/${session.id}` : null,
        version: "filed",
      });
      return reply.code(201).send(item);
    },
  );
}
