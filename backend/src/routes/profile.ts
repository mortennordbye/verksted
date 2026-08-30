import type { FastifyInstance } from "fastify";
import type { Profile } from "../../../shared/api.js";
import { PROFILE_BUDGET, appendProfileLine, readProfile, writeProfile } from "../profile-store.js";

/**
 * The profile, as a page you edit and a line the assistant may add to.
 *
 * Whole-text PUT rather than fields: it is one markdown file, and the settings
 * page is a textarea over it. The one narrow write is for the assistant, which
 * appends a line when told something and never rewrites what is there.
 */
export default async function profileRoutes(app: FastifyInstance) {
  app.get("/api/profile", async (): Promise<Profile> => {
    const text = await readProfile();
    return { text, used: Buffer.byteLength(text), budget: PROFILE_BUDGET };
  });

  app.put<{ Body: { text: string } }>(
    "/api/profile",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: { text: { type: "string", maxLength: PROFILE_BUDGET } },
        },
      },
    },
    async (req, reply): Promise<Profile | void> => {
      try {
        await writeProfile(req.body.text);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const text = await readProfile();
      return { text, used: Buffer.byteLength(text), budget: PROFILE_BUDGET };
    },
  );

  app.post<{ Body: { text: string } }>(
    "/api/profile/lines",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: { text: { type: "string", minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      try {
        await appendProfileLine(req.body.text);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );
}
