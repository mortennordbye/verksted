import type { FastifyInstance } from "fastify";
import type { MemoryList } from "../../../shared/api.js";
import * as memory from "../memory-store.js";
import { recentPrompts } from "../transcripts.js";

/**
 * Reading and editing what verksted has learned.
 *
 * The assistant writes these files itself; this exists so a person can see
 * everything that is being said about them on their behalf, and delete any of
 * it. A memory nobody can inspect is a memory nobody should trust.
 */
export default async function memoryRoutes(app: FastifyInstance) {
  app.get("/api/memory", async (): Promise<MemoryList> => {
    const memories = await memory.list();
    const { used, dropped } = memory.renderBlock(memories);
    return { memories, used, budget: memory.BUDGET_BYTES, dropped };
  });

  /**
   * The review queue. Everything here was proposed by something rather than
   * said by you, and none of it reaches a session until it is kept.
   *
   * Registered before /api/memory/:slug so "proposed" is a queue and not a
   * memory with an unfortunate name.
   */
  app.get("/api/memory/proposed", async () => ({ proposals: await memory.listProposals() }));

  app.post<{
    Body: { slug: string; text: string; type?: string; scope?: string; source?: string };
  }>(
    "/api/memory/proposed",
    {
      schema: {
        body: {
          type: "object",
          required: ["slug", "text"],
          additionalProperties: false,
          properties: {
            slug: { type: "string", minLength: 1, maxLength: 64 },
            text: { type: "string", minLength: 1, maxLength: 1000 },
            type: { enum: ["preference", "project", "reference"] },
            scope: { type: "string", minLength: 1, maxLength: 200 },
            source: { type: "string", maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return reply
          .code(201)
          .send(await memory.propose({ ...req.body, type: req.body.type as never }));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { slug: string } }>("/api/memory/proposed/:slug/keep", async (req, reply) => {
    const kept = await memory.keep(req.params.slug);
    if (!kept) return reply.code(404).send({ error: "not found" });
    return kept;
  });

  app.delete<{ Params: { slug: string } }>("/api/memory/proposed/:slug", async (req, reply) => {
    if (!(await memory.dropProposal(req.params.slug))) {
      return reply.code(404).send({ error: "not found" });
    }
    return { slug: req.params.slug };
  });

  app.put<{
    Params: { slug: string };
    Body: { text: string; type?: string; scope?: string; source?: string };
  }>(
    "/api/memory/:slug",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            // Long enough for a paragraph, short enough that one memory cannot
            // eat the whole injected budget by itself.
            text: { type: "string", minLength: 1, maxLength: 1000 },
            type: { enum: ["preference", "project", "reference"] },
            scope: { type: "string", minLength: 1, maxLength: 200 },
            source: { type: "string", maxLength: 300 },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await memory.save({
          slug: req.params.slug,
          ...req.body,
          type: req.body.type as never,
        });
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * The harvest's raw material: what the person typed into sessions that ended
   * recently. Nothing else from a transcript is readable here — see
   * transcripts.ts for why that is both the cost control and the defence.
   */
  app.get<{ Querystring: { hours?: number } }>(
    "/api/memory/material",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          // A week is the longest look-back worth having: beyond that a nightly
          // harvest is re-reading days it has already been through.
          properties: { hours: { type: "integer", minimum: 1, maximum: 168 } },
        },
      },
    },
    async (req) => recentPrompts(req.query.hours ?? 24),
  );

  app.delete<{ Params: { slug: string } }>("/api/memory/:slug", async (req, reply) => {
    if (!(await memory.remove(req.params.slug))) {
      return reply.code(404).send({ error: "not found" });
    }
    return { slug: req.params.slug };
  });
}
