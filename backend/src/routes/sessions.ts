import type { FastifyInstance } from "fastify";
import type { AgentName } from "../../../shared/api.js";
import { resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";

export default async function sessionRoutes(app: FastifyInstance) {
  app.get<{ Params: { name: string } }>(
    "/api/projects/:name/sessions",
    async (req, reply) => {
      try {
        resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      return store.listSessions(req.params.name);
    },
  );

  app.post<{ Params: { name: string }; Body: { agent: AgentName; title?: string } }>(
    "/api/projects/:name/sessions",
    {
      schema: {
        body: {
          type: "object",
          required: ["agent"],
          additionalProperties: false,
          properties: {
            agent: { enum: Object.keys(store.AGENT_COMMANDS) },
            title: { type: "string", maxLength: 120 },
          },
        },
      },
    },
    async (req, reply) => {
      let projectDir: string;
      try {
        projectDir = resolveInsideRepos(req.params.name);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      const session = await store.createSession(
        req.params.name,
        projectDir,
        req.body.agent,
        req.body.title,
      );
      return reply.code(201).send(session);
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = await store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not found" });
    return session;
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = await store.endSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not found" });
    return session;
  });
}
