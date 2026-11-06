import type { FastifyInstance } from "fastify";
import type { Skill, SkillList } from "../../../shared/api.js";
import { isClean } from "../assistant-taint.js";
import * as skills from "../skills-store.js";

/**
 * The assistant's skills, for the assistant to write and the person to see.
 *
 * Every route is local only, like the rest of /api (WireGuard is the boundary).
 * The one decision made here is whether a write is kept or queued: a skill is
 * instructions the chair follows on a later turn, so only a turn that has read
 * no stranger's text writes one outright.
 */
export default async function skillRoutes(app: FastifyInstance) {
  app.get("/api/skills", async (): Promise<SkillList> => {
    const [kept, proposals] = await Promise.all([skills.list(), skills.listProposals()]);
    return { skills: kept, proposals };
  });

  app.post<{ Params: { slug: string } }>("/api/skills/proposed/:slug/keep", async (req, reply) => {
    try {
      const kept = await skills.keep(req.params.slug);
      if (!kept) return reply.code(404).send({ error: "not found" });
      return kept;
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{ Params: { slug: string } }>("/api/skills/proposed/:slug", async (req, reply) => {
    if (!(await skills.drop(req.params.slug))) return reply.code(404).send({ error: "not found" });
    return { slug: req.params.slug };
  });

  app.get<{ Params: { slug: string } }>("/api/skills/:slug", async (req, reply) => {
    const skill = await skills.read(req.params.slug);
    if (!skill) return reply.code(404).send({ error: "not found" });
    return skill;
  });

  app.put<{
    Params: { slug: string };
    Body: { description: string; body: string; source?: string; turn?: string };
  }>(
    "/api/skills/:slug",
    {
      schema: {
        body: {
          type: "object",
          required: ["description", "body"],
          additionalProperties: false,
          properties: {
            description: { type: "string", minLength: 1, maxLength: skills.DESCRIPTION_MAX },
            body: { type: "string", minLength: 1, maxLength: skills.BODY_MAX },
            source: { type: "string", maxLength: 300 },
            // The assistant run that wrote it, from the environment the backend
            // set. With no run, or a run that read a stranger's text, it queues.
            turn: { type: "string", maxLength: 100 },
          },
        },
      },
    },
    async (req, reply) => {
      const { turn, ...rest } = req.body;
      const input = { slug: req.params.slug, ...rest };
      try {
        const kept = Boolean(turn && isClean(turn));
        const skill: Skill = kept ? await skills.save(input) : await skills.propose(input);
        return { skill, proposed: !kept };
      } catch (err) {
        return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.delete<{ Params: { slug: string } }>("/api/skills/:slug", async (req, reply) => {
    if (!(await skills.remove(req.params.slug)))
      return reply.code(404).send({ error: "not found" });
    return { slug: req.params.slug };
  });
}
