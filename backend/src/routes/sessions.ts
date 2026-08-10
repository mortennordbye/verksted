import type { FastifyInstance } from "fastify";
import type {
  AgentName,
  SessionCapture,
  SessionChanges,
  SessionChat,
  SessionFileDiff,
} from "../../../shared/api.js";
import { DEFAULT_WINDOW, MAX_WINDOW, readChat } from "../chat.js";
import { changesIn, fileDiffIn, gitError } from "../git.js";
import { repoRelPath, resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";
import { transcriptPath } from "../transcripts.js";
import * as tmux from "../tmux.js";

/** Same ceiling the project's file diff uses: enough for any one file, and a
 *  phone is not where a bigger one gets read. */
const MAX_DIFF_BYTES = 512 * 1024;

export default async function sessionRoutes(app: FastifyInstance) {
  // Every session across every project. The store already took an optional
  // filter; this is the view that matters when several agents are running and
  // you want to know which of them wants you.
  app.get("/api/sessions", () => store.listSessions());

  app.get<{ Params: { name: string } }>("/api/projects/:name/sessions", async (req, reply) => {
    try {
      resolveInsideRepos(req.params.name);
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
    return store.listSessions(req.params.name);
  });

  // `prompt` and `autoPermissions` are what an unattended caller needs, and the
  // assistant is one: it starts sessions nobody is watching yet. They were
  // missing from this schema while the store already supported both, and
  // fastify's ajv runs removeAdditional, so a prompt sent here was stripped in
  // silence — the session came up at an empty input and sat there.
  app.post<{
    Params: { name: string };
    Body: {
      agent: AgentName;
      title?: string;
      resume?: boolean;
      prompt?: string;
      autoPermissions?: boolean;
    };
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
            // Same ceiling as a schedule's prompt: it travels the same way, as
            // one env var handed to tmux.
            prompt: { type: "string", minLength: 1, maxLength: 4000 },
            autoPermissions: { type: "boolean" },
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
        prompt: req.body.prompt,
        autoPermissions: req.body.autoPermissions,
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

  /**
   * The session as a conversation rather than a terminal.
   *
   * Unlike capture, this outlives the session: the transcript is on the volume,
   * so a run that finished last week can still be read back. See chat.ts for
   * what is kept and why this costs nothing but a file read.
   *
   * `since` is the last timestamp the caller holds, so a poll that finds
   * nothing new answers with an empty list instead of the window again.
   */
  app.get<{ Params: { id: string }; Querystring: { bytes?: number; since?: string } }>(
    "/api/sessions/:id/chat",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            bytes: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_WINDOW,
              default: DEFAULT_WINDOW,
            },
            since: { type: "string", maxLength: 40 },
          },
        },
      },
    },
    async (req, reply): Promise<SessionChat | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const conversationId = await store.readConv(req.params.id);
      let file: string | null = null;
      if (conversationId) {
        try {
          file = transcriptPath(resolveInsideRepos(session.project), conversationId);
        } catch {
          // The project has been deleted; there is no cwd to derive a path from.
        }
      }
      return readChat(file, conversationId, { bytes: req.query.bytes, since: req.query.since });
    },
  );

  /**
   * What the session's commits changed — the evidence behind "3 commits · 2
   * files", rather than the counts alone.
   *
   * Committed work only. The working tree belongs to the project, not to a
   * session, and the project's git panel already shows it; a session's range is
   * the one thing that had no way to be read but by opening a terminal.
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/changes",
    async (req, reply): Promise<SessionChanges | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const range = await store.sessionRange(req.params.id);
      // Not a git repo, or a session from before the start commit was recorded:
      // there is no range, which is an answer rather than an error.
      if (!range) return { from: null, to: null, commits: [], files: [], truncated: false };
      try {
        const repoDir = resolveInsideRepos(session.project);
        return { ...range, ...(await changesIn(repoDir, range.from, range.to)) };
      } catch (err) {
        // The commit it started from is gone (the branch was reset), or the
        // project has been deleted. Either way the range cannot be read, and
        // saying so beats reporting an empty one as "it changed nothing".
        req.log.warn(err, "session changes failed");
        return reply.code(409).send({ error: gitError(err) });
      }
    },
  );

  /** One file's diff over that range, fetched when a file in it is opened. */
  app.get<{ Params: { id: string }; Querystring: { path: string } }>(
    "/api/sessions/:id/changes/diff",
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
    async (req, reply): Promise<SessionFileDiff | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const range = await store.sessionRange(req.params.id);
      if (!range) return reply.code(409).send({ error: "no range recorded" });
      let rel: string;
      let repoDir: string;
      try {
        rel = repoRelPath(req.query.path);
        repoDir = resolveInsideRepos(session.project);
      } catch {
        return reply.code(403).send({ error: "denied" });
      }
      try {
        const diff = await fileDiffIn(repoDir, range.from, range.to, rel);
        return {
          path: rel,
          diff: diff.slice(0, MAX_DIFF_BYTES),
          truncated: diff.length > MAX_DIFF_BYTES,
        };
      } catch (err) {
        req.log.warn(err, "session file diff failed");
        return reply.code(409).send({ error: gitError(err) });
      }
    },
  );
}
