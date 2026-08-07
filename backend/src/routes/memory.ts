import type { FastifyInstance } from "fastify";
import type { MemoryList } from "../../../shared/api.js";
import * as memory from "../memory-store.js";

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

  app.delete<{ Params: { slug: string } }>("/api/memory/:slug", async (req, reply) => {
    if (!(await memory.remove(req.params.slug))) {
      return reply.code(404).send({ error: "not found" });
    }
    return { slug: req.params.slug };
  });
}
