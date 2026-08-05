import type { FastifyInstance } from "fastify";
import type { AgentName, SessionCapture } from "../../../shared/api.js";
import { resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";
import * as tmux from "../tmux.js";

export default async function sessionRoutes(app: FastifyInstance) {
  // Every session across every project. The store already took an optional
  // filter; this is the view that matters when several agents are running and
  // you want to know which of them wants you.
  app.get("/api/sessions", () => store.listSessions());

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

  app.post<{
    Params: { name: string };
    Body: { agent: AgentName; title?: string; resume?: boolean };
  }>(
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
            resume: { type: "boolean" },
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
      const session = await store.createSession(req.params.name, projectDir, req.body.agent, {
        title: req.body.title,
        resume: req.body.resume,
      });
      return reply.code(201).send(session);
    },
  );

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req, reply) => {
    const session = await store.getSession(req.params.id);
    if (!session) return reply.code(404).send({ error: "not found" });
    return session;
  });

  // Default: end the session but keep it in history. purge=1 also removes it
  // from history (metadata file).
  app.delete<{ Params: { id: string }; Querystring: { purge?: string } }>(
    "/api/sessions/:id",
    async (req, reply) => {
      if (req.query.purge === "1") {
        const ok = await store.deleteSession(req.params.id);
        if (!ok) return reply.code(404).send({ error: "not found" });
        return { id: req.params.id };
      }
      const session = await store.endSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      return session;
    },
  );

  /**
   * Type into a session without opening its terminal.
   *
   * This is what makes a permission prompt answerable from a notification: "y",
   * Enter, done. It grants nothing the attach websocket did not already — that
   * socket carries arbitrary keystrokes to the same pane — so the guard is the
   * same one, the Origin check in app.ts.
   */
  app.post<{ Params: { id: string }; Body: { text: string; enter?: boolean } }>(
    "/api/sessions/:id/input",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", maxLength: 10_000 },
            enter: { type: "boolean", default: true },
          },
        },
      },
    },
    async (req, reply) => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      if (session.status === "done") {
        return reply.code(409).send({ error: "session has ended" });
      }
      try {
        await tmux.sendText(req.params.id, req.body.text, req.body.enter !== false);
      } catch (err) {
        req.log.error(err, "send-keys failed");
        return reply.code(502).send({ error: "could not reach the session" });
      }
      return { ok: true };
    },
  );

  /**
   * The last N lines the session printed.
   *
   * Enough context to answer a prompt without opening the terminal, and the
   * only way to get the text off a phone at all — xterm's canvas is not
   * selectable, so an error you want to paste elsewhere is otherwise a photo.
   */
  app.get<{ Params: { id: string }; Querystring: { lines?: number } }>(
    "/api/sessions/:id/capture",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { lines: { type: "integer", minimum: 1, maximum: 500, default: 40 } },
        },
      },
    },
    async (req, reply): Promise<SessionCapture | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      if (session.status === "done") return { id: req.params.id, text: "", live: false };
      try {
        const text = await tmux.capturePane(req.params.id, req.query.lines ?? 40);
        // tmux pads to the pane width, which is a lot of trailing space on a
        // phone-sized pane.
        return { id: req.params.id, text: text.replace(/[ \t]+$/gm, "").trimEnd(), live: true };
      } catch (err) {
        req.log.error(err, "capture-pane failed");
        return reply.code(502).send({ error: "could not read the session" });
      }
    },
  );
}
