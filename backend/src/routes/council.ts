import type { FastifyInstance } from "fastify";
import type { CouncilMember } from "../../../shared/api.js";
import * as council from "../council-store.js";
import { MemberDeniedError } from "../council-store.js";
import { listForMember, saveForMember, forgetForMember } from "../memory-store.js";
import * as tts from "../tts.js";

/**
 * The council roster, and what each advisor privately knows.
 *
 * A member is data on the volume, so this is ordinary CRUD — with one rule that
 * is not: validation happens here, on the way in, rather than being trusted to
 * whatever reads the file later. A tool name that is a typo, or one that is the
 * chair's alone, is a 400 on the settings page instead of something a child
 * process finds out about.
 *
 * The voice is checked here rather than in the store because the store also
 * validates on the way out, and a pod that loses its voice model must not lose
 * its roster with it.
 */
const ID = { type: "string", pattern: "^[a-z][a-z0-9-]{0,31}$" };

export default async function councilRoutes(app: FastifyInstance) {
  app.get("/api/council", () => council.listCouncil());

  /** The tools a member may be given, so the settings page can offer them. */
  app.get("/api/council/tools", () => ({ tools: council.TOOL_INVENTORY }));

  app.put<{ Params: { id: string }; Body: Partial<CouncilMember> }>(
    "/api/council/:id",
    {
      schema: {
        params: { type: "object", required: ["id"], properties: { id: ID } },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 60 },
            remit: { type: "string", minLength: 1, maxLength: council.MAX_REMIT },
            // Carried with every turn this member takes, so it is capped the way
            // the assistant's standing orders are: about a screenful.
            persona: { type: "string", maxLength: council.MAX_PERSONA },
            model: { type: "string", maxLength: 60 },
            effort: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
            tools: { type: "array", maxItems: 40, items: { type: "string", maxLength: 40 } },
            web: { type: "boolean" },
            voice: { type: "string", maxLength: 40 },
            colour: {
              type: "string",
              enum: ["amber", "violet", "teal", "rose", "sky", "lime"],
            },
            enabled: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      // Only when this pod has a voice at all: the list comes from the model's
      // own ready line, so a pod without one has nothing to check against, and
      // refusing every name there would hold the roster hostage to an optional
      // feature. Where there is a list, a typo is an error on the form rather
      // than a sample button that does nothing.
      const voice = (req.body.voice ?? "").trim();
      if (voice && tts.available()) {
        const known = await tts.voices();
        if (!known.includes(voice)) {
          return reply.code(400).send({ error: `no such voice on this pod: ${voice}` });
        }
      }
      try {
        return await council.saveMember({ ...req.body, id: req.params.id });
      } catch (err) {
        if (err instanceof MemberDeniedError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/council/:id",
    { schema: { params: { type: "object", required: ["id"], properties: { id: ID } } } },
    async (req, reply) => {
      try {
        if (!(await council.deleteMember(req.params.id))) {
          return reply.code(404).send({ error: "no such member" });
        }
        return { deleted: true };
      } catch (err) {
        if (err instanceof MemberDeniedError) return reply.code(400).send({ error: err.message });
        throw err;
      }
    },
  );

  /**
   * What one advisor alone has been told.
   *
   * Kept apart from /api/memory on purpose: these never reach a session, and a
   * single list that mixed them would be one filter away from a leak.
   */
  app.get<{ Params: { id: string } }>(
    "/api/council/:id/memory",
    { schema: { params: { type: "object", required: ["id"], properties: { id: ID } } } },
    async (req, reply) => {
      if (!(await council.getMember(req.params.id))) {
        return reply.code(404).send({ error: "no such member" });
      }
      return { memories: await listForMember(req.params.id) };
    },
  );

  app.put<{ Params: { id: string; slug: string }; Body: { text: string; source?: string } }>(
    "/api/council/:id/memory/:slug",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "slug"],
          properties: { id: ID, slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" } },
        },
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: 2_000 },
            source: { type: "string", maxLength: 200 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!(await council.getMember(req.params.id))) {
        return reply.code(404).send({ error: "no such member" });
      }
      return saveForMember(req.params.id, {
        slug: req.params.slug,
        text: req.body.text,
        source: req.body.source,
      });
    },
  );

  app.delete<{ Params: { id: string; slug: string } }>(
    "/api/council/:id/memory/:slug",
    {
      schema: {
        params: {
          type: "object",
          required: ["id", "slug"],
          properties: { id: ID, slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" } },
        },
      },
    },
    async (req, reply) => {
      if (!(await forgetForMember(req.params.id, req.params.slug))) {
        return reply.code(404).send({ error: "no such memory" });
      }
      return { deleted: true };
    },
  );
}
