import type { FastifyInstance } from "fastify";
import type {
  AgentName,
  ChatDetail,
  SessionPrompt,
  ReviewVerdict,
  SessionCapture,
  SessionChanges,
  SessionChat,
  SessionFileDiff,
  SessionPatch,
  SessionReview,
} from "../../../shared/api.js";
import { DEFAULT_WINDOW, MAX_WINDOW, readChat, readDetail, readImage } from "../chat.js";
import { changesIn, fileDiffIn, gitError, rangeDiff } from "../git.js";
import { repoRelPath, resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";
import { subagentDir, transcriptPath } from "../transcripts.js";
import * as tmux from "../tmux.js";
import { parseActivity, parseMode, parsePrompt } from "../tui-prompt.js";

/** Same ceiling the project's file diff uses: enough for any one file, and a
 *  phone is not where a bigger one gets read. */
const MAX_DIFF_BYTES = 512 * 1024;

/** The keys a client may press, and what tmux calls them. */
const KEYS = { escape: "Escape", right: "Right", "shift-tab": "BTab" } as const;

/**
 * Where a session's transcript is, if it has one.
 *
 * Three answers, and the difference matters at the route: `undefined` is a
 * session that does not exist, `null` is one that has written nothing to read —
 * an agent other than claude, or a session in its first seconds — and a string
 * is a path derived from the conversation id the session itself recorded.
 * Nothing a client sends takes part in building it.
 */
async function transcriptFor(id: string): Promise<string | null | undefined> {
  const session = await store.getSession(id);
  if (!session) return undefined;
  const conversationId = await store.readConv(id);
  if (!conversationId) return null;
  try {
    return transcriptPath(resolveInsideRepos(session.project), conversationId);
  } catch {
    // The project has been deleted; there is no cwd to derive a path from.
    return null;
  }
}

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
  app.post<{
    Params: { id: string };
    Body: { text?: string; enter?: boolean; key?: "escape" | "right" | "shift-tab" };
  }>(
    "/api/sessions/:id/input",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          // One or the other. Text is typed literally, which is why a key needs
          // its own field rather than being spelled inside a message.
          anyOf: [{ required: ["text"] }, { required: ["key"] }],
          properties: {
            text: { type: "string", maxLength: 10_000 },
            enter: { type: "boolean", default: true },
            // A closed set, so no tmux key name can arrive from a client.
            // Escape interrupts a working agent and backs out of a dialog;
            // right is how a question with several answers moves on from
            // ticking boxes to the screen that submits them; shift-tab is the
            // permission-mode toggle, the one thing the terminal's chip could
            // do that the chat could only report on.
            key: { enum: ["escape", "right", "shift-tab"] },
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
        if (req.body.key) {
          await tmux.sendKey(req.params.id, KEYS[req.body.key]);
        } else {
          await tmux.sendText(req.params.id, req.body.text ?? "", req.body.enter !== false);
        }
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
   * What the session is blocked on, whether it is working, and which mode it is
   * in — all as its terminal is drawing them.
   *
   * Deliberately not part of `/chat`. That endpoint is a file read and cannot
   * drift from what happened; this one scrapes a pane, which is a different
   * kind of answer with a different shelf life, and mixing them would make the
   * whole conversation only as trustworthy as the scrape.
   *
   * It is also why this is polled separately and only when there is reason to
   * think somebody is being asked something. Null is not an error — it is the
   * common case, and it is what a session that simply finished its turn says.
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/prompt",
    async (req, reply): Promise<SessionPrompt | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const quiet = { prompt: null, mode: null, busy: false, doing: null };
      if (session.status === "done") return quiet;
      try {
        // One capture, three readings — the pane is the same pane.
        const pane = await tmux.capturePane(req.params.id, 40);
        return { prompt: parsePrompt(pane), mode: parseMode(pane), ...parseActivity(pane) };
      } catch (err) {
        // A pane that cannot be read is not a pane that is asking anything.
        req.log.error(err, "capture-pane failed");
        return quiet;
      }
    },
  );

  /**
   * The bytes of one image a session produced.
   *
   * Only for the images that exist nowhere but the transcript — a browser
   * screenshot, or a file read from outside the project. Anything the agent
   * read out of the repo carries a path instead, and the file viewer's own
   * route serves it, already scoped and already cached.
   *
   * The client names a transcript key and a nothing else: there is no path here
   * for it to traverse, and the only file opened is the session's own
   * transcript. What comes back is checked against an allowlist of raster
   * types — an SVG out of a tool result is arbitrary markup and would be served
   * from this app's origin, which no screenshot is worth.
   */
  app.get<{ Params: { id: string }; Querystring: { ref: string; bytes?: number } }>(
    "/api/sessions/:id/chat/image",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["ref"],
          additionalProperties: false,
          properties: {
            ref: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" },
            bytes: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_WINDOW,
              default: DEFAULT_WINDOW,
            },
          },
        },
      },
    },
    async (req, reply) => {
      const file = await transcriptFor(req.params.id);
      if (file === undefined) return reply.code(404).send({ error: "not found" });
      const image = await readImage(file, req.query.ref, req.query.bytes);
      if (!image) return reply.code(404).send({ error: "not found" });
      return (
        reply
          .header("content-type", image.mediaType)
          .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
          .header("x-content-type-options", "nosniff")
          .header("content-disposition", 'inline; filename="image"')
          // A transcript entry never changes, so this is safe to hold on to — and
          // on a phone it is the difference between one fetch and one per poll.
          .header("cache-control", "private, max-age=3600, immutable")
          .send(image.data)
      );
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
  /**
   * One tool call, opened.
   *
   * The chat carries a chip per call and nothing of what the call printed,
   * which is what keeps a poll the same size whether the session ran `ls` or a
   * test suite that printed a megabyte. This is where that megabyte lives, and
   * it only moves when somebody taps the chip.
   *
   * `ref` is the transcript's own tool_use id. It is matched against ids read
   * out of the file and never touches a path, so the only thing on disk this
   * can reach is the session's own transcript — the same one `/chat` derives
   * from the conversation id it recorded. A reference that is not in the window
   * answers "nothing to show" rather than saying whether it ever existed.
   */
  app.get<{ Params: { id: string }; Querystring: { ref: string; bytes?: number } }>(
    "/api/sessions/:id/chat/detail",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["ref"],
          additionalProperties: false,
          properties: {
            ref: { type: "string", pattern: "^[A-Za-z0-9_-]{1,80}$" },
            bytes: {
              type: "integer",
              minimum: 1_000,
              maximum: MAX_WINDOW,
              default: DEFAULT_WINDOW,
            },
          },
        },
      },
    },
    async (req, reply): Promise<ChatDetail | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const file = await transcriptFor(req.params.id);
      const conversationId = await store.readConv(req.params.id);
      // Where this conversation's subagents kept their own transcripts, for the
      // one kind of call whose detail is in a second file.
      let subagents: string | undefined;
      if (conversationId) {
        try {
          subagents = subagentDir(resolveInsideRepos(session.project), conversationId);
        } catch {
          // The project is gone; a subagent chip then opens onto nothing.
        }
      }
      return readDetail(file ?? null, req.query.ref, {
        bytes: req.query.bytes,
        subagentDir: subagents,
      });
    },
  );

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
      const file = await transcriptFor(req.params.id);
      if (file === undefined) return reply.code(404).send({ error: "not found" });
      // The repo is what lets an image the agent read be recognised as a file
      // this project can serve on its own, rather than one to decode out of the
      // transcript. Its absence only costs the cheaper of the two routes.
      let repoDir: string | undefined;
      try {
        repoDir = resolveInsideRepos(session.project);
      } catch {
        // The project has been deleted; every image falls back to its bytes.
      }
      return readChat(file, conversationId, {
        bytes: req.query.bytes,
        since: req.query.since,
        repoDir,
      });
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
      const review = await store.getReview(req.params.id);
      // Not a git repo, or a session from before the start commit was recorded:
      // there is no range, which is an answer rather than an error.
      if (!range) {
        return { from: null, to: null, commits: [], files: [], truncated: false, review };
      }
      try {
        const repoDir = resolveInsideRepos(session.project);
        return { ...range, ...(await changesIn(repoDir, range.from, range.to)), review };
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

  /**
   * The whole range as one patch, which is what reviewing a run means: reading
   * it end to end rather than tapping through it a file at a time.
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/changes/patch",
    async (req, reply): Promise<SessionPatch | void> => {
      const session = await store.getSession(req.params.id);
      if (!session) return reply.code(404).send({ error: "not found" });
      const range = await store.sessionRange(req.params.id);
      if (!range) return { diff: "", truncated: false };
      try {
        return await rangeDiff(resolveInsideRepos(session.project), range.from, range.to);
      } catch (err) {
        req.log.warn(err, "session patch failed");
        return reply.code(409).send({ error: gitError(err) });
      }
    },
  );

  /**
   * A step of a review: a file marked read, a verdict on the run, or both.
   *
   * The path is not resolved against the disk on purpose — nothing is opened
   * here. It is a label recorded against the session, and it is bounded and
   * kept as sent so it matches what the changes list spells.
   */
  app.patch<{
    Params: { id: string };
    Body: { file?: { path: string; read: boolean }; verdict?: ReviewVerdict | null };
  }>(
    "/api/sessions/:id/review",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            file: {
              type: "object",
              required: ["path", "read"],
              additionalProperties: false,
              properties: {
                path: { type: "string", minLength: 1, maxLength: 1000 },
                read: { type: "boolean" },
              },
            },
            verdict: { type: ["string", "null"], enum: ["approved", "needs-work", null] },
          },
        },
      },
    },
    async (req, reply): Promise<SessionReview | void> => {
      const review = await store.setReview(req.params.id, req.body);
      if (!review) return reply.code(404).send({ error: "not found" });
      return review;
    },
  );
}
