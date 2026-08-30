import type { FastifyInstance } from "fastify";
import type { DocEntry, DocHit } from "../../../shared/api.js";
import * as docs from "../docs.js";
import { PathDeniedError } from "../paths.js";

/**
 * The documents, read. 503 with a sentence when no share is mounted; 404 for
 * a path that is not inside it, indistinguishable from one that does not
 * exist, which is the one thing the scoping is there to hide.
 */
const PATH = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string", maxLength: 1000 } },
};

export default async function docsRoutes(app: FastifyInstance) {
  const guard = async <T>(
    fn: () => Promise<T>,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof docs.DocsUnavailable) return reply.code(503).send({ error: err.message });
      if (err instanceof PathDeniedError || (err as { code?: string }).code === "ENOENT") {
        return reply.code(404).send({ error: "not found" });
      }
      app.log.warn(err, "documents failed");
      return reply.code(502).send({ error: "the documents could not be read" });
    }
  };

  app.get<{ Querystring: { path?: string } }>(
    "/api/docs",
    { schema: { querystring: PATH } },
    (req, reply) => guard<DocEntry[]>(() => docs.list(req.query.path ?? ""), reply),
  );

  app.get<{ Querystring: { path: string } }>(
    "/api/docs/read",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["path"],
          additionalProperties: false,
          properties: { path: { type: "string", minLength: 1, maxLength: 1000 } },
        },
      },
    },
    (req, reply) =>
      guard(async () => {
        const doc = await docs.read(req.query.path);
        return doc ?? reply.code(404).send({ error: "not found" });
      }, reply),
  );

  app.get<{ Querystring: { q: string } }>(
    "/api/docs/search",
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
    (req, reply) => guard<DocHit[]>(() => docs.search(req.query.q), reply),
  );

  app.get("/api/docs/catalogue", (_req, reply) =>
    guard(async () => ({ text: await docs.catalogueText() }), reply),
  );
}
