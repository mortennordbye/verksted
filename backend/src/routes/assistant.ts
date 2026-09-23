import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type {
  AssistantEntry,
  AssistantFrame,
  AssistantThread,
  AssistantTool,
  AssistantVoices,
  ToolLogDay,
  UnattendedRun,
} from "../../../shared/api.js";
import * as assistant from "../assistant.js";
import { agentUser } from "../agent-user.js";
import { assistantHome } from "../assistant-policy.js";
import { transcriptPath } from "../claude-home.js";
import { DESK, ensureDesk } from "../desk.js";
import { createSession } from "../session-launch.js";
import { env } from "../env.js";
import { BusyError } from "../serial.js";
import { readAssistantConfig, writeAssistantConfig } from "../settings-store.js";
import * as toolLog from "../tool-log.js";
import { UndoRefused, undo } from "../undo.js";
import { MailDenied } from "../mail.js";
import { CalendarNotFound, CalendarRefused } from "../calendar.js";
import { MAX_CLIP_BYTES, transcribe } from "../transcribe.js";
import * as tts from "../tts.js";
import { MAX_TEXT } from "../tts.js";
import { perMinute } from "../limits.js";

/**
 * The assistant's thread, and the one websocket that pushes it.
 *
 * Deliberately small: a turn is a POST, and the socket exists so a phone
 * watching the thread sees the turn land without polling. The POST answers
 * when the turn is done, or, for a caller that has the socket and says
 * `wait: false`, as soon as the question is on record. Everything the socket sends is the whole thread, because a thread is
 * a handful of kilobytes and a diff protocol would be the only stateful thing
 * in this app.
 */
export default async function assistantRoutes(app: FastifyInstance) {
  app.get("/api/assistant", () => assistant.readThread());

  app.post<{
    Body: { text: string; images?: string[]; roundTable?: boolean; wait?: boolean };
  }>(
    "/api/assistant/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          // Long enough to paste an error into, short enough that a runaway
          // client cannot put a megabyte on the volume in one call.
          properties: {
            text: { type: "string", minLength: 1, maxLength: 20_000 },
            // Names returned by the upload route, never paths: the server
            // decides where they live, so nothing here can point elsewhere.
            images: {
              type: "array",
              maxItems: 4,
              items: { type: "string", pattern: "^[0-9a-f-]{36}\\.[a-z]{3,4}$" },
            },
            // Ask the council to talk this one over rather than answer in
            // parallel. Per turn, not a setting: it costs more and takes longer,
            // so it is a thing you switch on for a question worth it.
            roundTable: { type: "boolean" },
            // False answers 202 as soon as the question is recorded, with the
            // thread as it then stands; the socket carries the turn. The chat
            // screen asks for that. The default still answers when the turn is
            // done, which is what a caller with no socket wants.
            wait: { type: "boolean" },
          },
        },
      },
    },
    async (req, reply) => {
      const text = req.body.text.trim();
      if (!text) return reply.code(400).send({ error: "say something" });
      try {
        if (req.body.wait === false) {
          // Asked now, or queued behind the turn that is running: the socket
          // carries both. What went wrong is in the thread by now (see
          // `begin`); this is the copy for whoever reads the pod's log.
          const { thread, done } = await assistant.ask(
            text,
            req.body.images ?? [],
            req.body.roundTable === true,
          );
          done?.catch((err: unknown) => req.log.error(err, "assistant turn failed"));
          return await reply.code(202).send(thread);
        }
        const { done } = await assistant.begin(
          text,
          req.body.images ?? [],
          req.body.roundTable === true,
        );
        return await done;
      } catch (err) {
        // The only expected throw is "already running", which is a conflict
        // rather than a server fault: the client should wait, not retry.
        if (err instanceof Error && /still running/.test(err.message)) {
          return reply.code(409).send({ error: err.message });
        }
        // The day's ceiling: not a fault either, and not one to wait out.
        if (err instanceof BusyError) return reply.code(429).send({ error: err.message });
        req.log.error(err, "assistant turn failed");
        return reply.code(502).send({ error: "the assistant could not be reached" });
      }
    },
  );

  /**
   * An image from the phone, where there is no clipboard to paste from.
   *
   * Stored under a server-chosen uuid name and handed back by name only. The
   * agent reads it from disk by path (it has Read and the directory is granted
   * with --add-dir), so nothing about the file crosses into a prompt except
   * where to find it.
   */
  app.post<{ Querystring: { type: string } }>(
    "/api/assistant/uploads",
    {
      config: perMinute(60),
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        querystring: {
          type: "object",
          required: ["type"],
          additionalProperties: false,
          properties: { type: { enum: ["png", "jpg", "jpeg", "gif", "webp"] } },
        },
      },
    },
    async (req, reply) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(415).send({ error: "raw body required" });
      }
      const name = `${crypto.randomUUID()}.${req.query.type}`;
      await fs.mkdir(assistant.uploadsDir(), { recursive: true });
      await fs.writeFile(path.join(assistant.uploadsDir(), name), body);
      return { name };
    },
  );

  // Serving them back is what lets the chat show what was sent.
  app.get<{ Params: { name: string } }>("/api/assistant/uploads/:name", async (req, reply) => {
    if (!/^[0-9a-f-]{36}\.[a-z]{3,4}$/.test(req.params.name)) {
      return reply.code(404).send({ error: "not found" });
    }
    try {
      const file = path.join(assistant.uploadsDir(), req.params.name);
      const ext = path.extname(req.params.name).slice(1);
      return reply.type(`image/${ext === "jpg" ? "jpeg" : ext}`).send(await fs.readFile(file));
    } catch {
      return reply.code(404).send({ error: "not found" });
    }
  });

  /**
   * A recorded clip in, text out. The browser records; the pod transcribes.
   *
   * 422 rather than 200-with-empty-string when nothing was said: a caller that
   * cannot tell silence from a failed transcription will happily send "" to the
   * assistant and wait for an answer to nothing.
   */
  app.post(
    "/api/assistant/transcribe",
    { bodyLimit: MAX_CLIP_BYTES },
    async (req, reply): Promise<{ text: string } | void> => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return reply.code(415).send({ error: "raw audio body required" });
      }
      try {
        const text = await transcribe(body);
        if (!text) return reply.code(422).send({ error: "nothing was said" });
        return { text };
      } catch (err) {
        if (err instanceof BusyError) return reply.code(429).send({ error: err.message });
        req.log.error(err, "transcription failed");
        return reply.code(502).send({ error: "could not transcribe that" });
      }
    },
  );

  /**
   * The other direction: text in, spoken audio out.
   *
   * One chunk per request, because the frontend splits a reply into sentences
   * and plays the first while the rest are still being made — synthesis is
   * roughly a third of real time, so a whole answer in one request would be a
   * long wait before any sound at all.
   *
   * A pod without the model answers 503 rather than an error: the browser's own
   * voice is the fallback, and the client needs to be able to tell the
   * difference between "no voice here" and "the voice broke".
   */
  app.post<{ Body: { text: string; voice?: string } }>(
    "/api/assistant/speak",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1, maxLength: MAX_TEXT },
            // Checked against the model's own list in tts.ts, not here.
            voice: { type: "string", maxLength: 40 },
          },
        },
      },
    },
    async (req, reply) => {
      if (!tts.available()) return reply.code(503).send({ error: "no voice on this pod" });
      try {
        // A voice this model does not have is the caller's mistake, and saying
        // so beats a 502 that reads as "the pod is broken".
        if (req.body.voice && !(await tts.voices()).includes(req.body.voice)) {
          return reply.code(400).send({ error: `no such voice: ${req.body.voice}` });
        }
        const wav = await tts.synthesize(
          req.body.text,
          req.body.voice,
          () => req.raw.socket.destroyed,
        );
        // Immutable for the client's purposes: the same text and voice make the
        // same audio, and a reply is often re-read.
        return reply.type("audio/wav").header("cache-control", "private, max-age=300").send(wav);
      } catch (err) {
        if (err instanceof BusyError) return reply.code(429).send({ error: err.message });
        req.log.error(err, "synthesis failed");
        return reply.code(502).send({ error: "could not say that" });
      }
    },
  );

  /** The voices this pod can speak in; empty when it has none. */
  app.get("/api/assistant/voices", async (req): Promise<AssistantVoices> => {
    try {
      return { voices: await tts.voices(), current: env.KOKORO_VOICE };
    } catch (err) {
      // A model that will not load is a pod with no voice, not a broken screen.
      req.log.error(err, "voices unavailable");
      return { voices: [], current: env.KOKORO_VOICE };
    }
  });

  /**
   * Older conversations, searched. The assistant's own long-term recall: it
   * cannot read the thread files (they are outside every directory it is
   * granted), so this endpoint is the only way back into what was said before.
   */
  app.get<{ Querystring: { q: string } }>(
    "/api/assistant/search",
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
    async (req) => ({ hits: await assistant.search(req.query.q) }),
  );

  app.get("/api/assistant/config", () => readAssistantConfig());

  /** What it can do, as its own tool server says. */
  app.get("/api/assistant/tools", (): Promise<AssistantTool[]> => assistant.listTools());

  app.put<{
    Body: { name?: string; model?: string; effort?: string; instructions?: string };
  }>(
    "/api/assistant/config",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", maxLength: 40 },
            // Free text rather than an enum: model aliases come and go, and a
            // settings page that cannot name a new one is worse than one that
            // lets a typo through and says so on the next turn.
            model: { type: "string", minLength: 1, maxLength: 60 },
            effort: { enum: ["low", "medium", "high", "xhigh", "max"] },
            // Every turn carries this, so it is capped at roughly a screenful.
            instructions: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (req) => {
      await writeAssistantConfig(req.body as Parameters<typeof writeAssistantConfig>[0]);
      return readAssistantConfig();
    },
  );

  /**
   * One tool call that changed something, as the tool server finishes it.
   *
   * Said by the MCP server, not by a model: the turn, the speaker and whether
   * anybody was reading all come from the environment the backend wrote, and
   * the tool and its effect come from the policy table the server holds. What
   * a model decides is the arguments, which is exactly what is worth keeping.
   *
   * Reads never arrive here (see tool-log.ts). A failure to record is the
   * caller's to report — by then the call has already happened, and answering
   * an error would only have the model do it a second time.
   */
  app.post<{
    Body: {
      turn: string;
      speaker: string;
      unattended: boolean;
      tool: string;
      effect: string;
      args?: Record<string, unknown>;
      ok: boolean;
      result?: string;
    };
  }>(
    "/api/assistant/turn/tool",
    {
      schema: {
        body: {
          type: "object",
          required: ["turn", "speaker", "unattended", "tool", "effect", "ok"],
          additionalProperties: false,
          properties: {
            turn: { type: "string", maxLength: 100 },
            speaker: { type: "string", maxLength: 100 },
            unattended: { type: "boolean" },
            tool: { type: "string", maxLength: 100 },
            effect: { type: "string", maxLength: 40 },
            args: { type: "object" },
            ok: { type: "boolean" },
            result: { type: "string", maxLength: 4000 },
          },
        },
      },
    },
    async (req) => {
      await toolLog.record({
        ...req.body,
        args: req.body.args ?? {},
        result: req.body.result ?? "",
      });
      return { recorded: true };
    },
  );

  /** A day of that log, for the settings page. No day is the newest one. */
  app.get<{ Querystring: { day?: string } }>(
    "/api/assistant/tool-log",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
        },
      },
    },
    (req): Promise<ToolLogDay> => toolLog.readDay(req.query.day),
  );

  /**
   * Put back one call from that log, from its row on the settings page. What
   * is undone is only ever what the mail log or the calendar's kept copy
   * recorded that call doing (see undo.ts).
   */
  app.post<{ Body: { day: string; at: string } }>(
    "/api/assistant/tool-log/undo",
    {
      schema: {
        body: {
          type: "object",
          required: ["day", "at"],
          additionalProperties: false,
          properties: {
            day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            at: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
            },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return { said: await undo(req.body.day, req.body.at) };
      } catch (err) {
        // Refusals say why; anything else is the global handler's.
        if (
          err instanceof UndoRefused ||
          err instanceof MailDenied ||
          err instanceof CalendarNotFound ||
          err instanceof CalendarRefused
        ) {
          return reply.code(409).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.post("/api/assistant/stop", () => ({ stopped: assistant.stop() }));

  /** Take back a message that is still waiting for the turn in front of it. */
  app.delete<{ Params: { id: string } }>(
    "/api/assistant/queue/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
        },
      },
    },
    (req, reply) =>
      assistant.unqueue(req.params.id)
        ? { removed: true }
        : reply.code(404).send({ error: "not waiting" }),
  );

  /** The briefing, triage or journal turn in flight, which the chat's stop does not reach. */
  app.get("/api/assistant/unattended", (): { running: UnattendedRun | null } => ({
    running: assistant.unattendedStatus(),
  }));

  app.post("/api/assistant/unattended/stop", () => ({ stopped: assistant.stopUnattended() }));

  app.post("/api/assistant/new", async (_req, reply) => {
    try {
      return { conversationId: await assistant.newConversation() };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get<{ Querystring: { q?: string } }>(
    "/api/assistant/threads",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { q: { type: "string", maxLength: 200 } },
        },
      },
    },
    (req) => assistant.listThreads(req.query.q ?? ""),
  );

  app.post<{ Params: { id: string } }>(
    "/api/assistant/threads/:id/open",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
        },
      },
    },
    async (req, reply) => {
      try {
        await assistant.openConversation(req.params.id);
        return assistant.readThread();
      } catch (err) {
        const message = (err as Error).message;
        return reply.code(message === "no such thread" ? 404 : 409).send({ error: message });
      }
    },
  );

  const threadId = {
    type: "object",
    required: ["id"],
    properties: { id: { type: "string", pattern: "^[0-9a-f-]{36}$" } },
  };

  // Deleting is for good, so the screen asks first; the server only refuses
  // what would pull a thread out from under a turn still running in it.
  app.delete<{ Params: { id: string } }>(
    "/api/assistant/threads/:id",
    { schema: { params: threadId } },
    async (req, reply) => {
      try {
        await assistant.deleteConversation(req.params.id);
        return { deleted: true };
      } catch (err) {
        const message = (err as Error).message;
        return reply.code(message === "no such thread" ? 404 : 409).send({ error: message });
      }
    },
  );

  app.put<{ Params: { id: string }; Body: { title: string } }>(
    "/api/assistant/threads/:id/title",
    {
      schema: {
        params: threadId,
        body: {
          type: "object",
          required: ["title"],
          additionalProperties: false,
          properties: { title: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      try {
        await assistant.renameThread(req.params.id, req.body.title);
        return { ok: true };
      } catch (err) {
        const message = (err as Error).message;
        return reply.code(message === "no such thread" ? 404 : 400).send({ error: message });
      }
    },
  );

  // Markdown, as a download: the name is the title, reduced to what every
  // filesystem takes, since it lands in a header.
  app.get<{ Params: { id: string } }>(
    "/api/assistant/threads/:id/export",
    { schema: { params: threadId } },
    async (req, reply) => {
      try {
        const { title, text } = await assistant.exportThread(req.params.id);
        const name =
          title
            .replace(/[^A-Za-z0-9 ._-]+/g, "")
            .trim()
            .slice(0, 60)
            .replace(/\s+/g, "-") || "thread";
        return reply
          .header("content-type", "text/markdown; charset=utf-8")
          .header("content-disposition", `attachment; filename="${name}.md"`)
          .send(text);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * The thread in a terminal, to drive rather than chat to (Assistant M1).
   *
   * A desk session forking the chair's claude conversation: the transcript is
   * copied beside the desk, where `--resume` looks, and `--fork-session` makes
   * the terminal a conversation of its own, so what is typed there never lands
   * in the chat's. Not while sessions run as their own user: the assistant's
   * HOME is kept from that user on purpose, since it holds the mail and the
   * calendar a turn has read.
   */
  app.post<{ Params: { id: string } }>(
    "/api/assistant/threads/:id/terminal",
    { schema: { params: threadId } },
    async (req, reply) => {
      // The schema holds it to a uuid too; said again beside the paths it builds.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(req.params.id)) {
        return reply.code(404).send({ error: "not a thread id" });
      }
      if (agentUser()) {
        return reply.code(409).send({
          error:
            "not while sessions run as their own user: the assistant's conversations are kept from it",
        });
      }
      const from = transcriptPath(env.REPOS_DIR, req.params.id, assistantHome());
      try {
        await fs.access(from);
      } catch {
        return reply.code(404).send({ error: "this thread has no conversation to open yet" });
      }
      const desk = await ensureDesk();
      const to = transcriptPath(desk, req.params.id);
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      const threads = await assistant.listThreads();
      const title = threads.find((t) => t.conversationId === req.params.id)?.title ?? "thread";
      try {
        const session = await createSession(DESK, desk, "claude", {
          title: `assistant: ${title}`.slice(0, 80),
          fork: req.params.id,
        });
        return reply.code(201).send(session);
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    },
  );

  /** Clear out the history: every thread but the open one, or only the old ones. */
  app.post<{ Body: { olderThanDays?: number } }>(
    "/api/assistant/threads/clear",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: { olderThanDays: { type: "integer", minimum: 0, maximum: 3650 } },
        },
      },
    },
    async (req) => ({ deleted: await assistant.clearThreads(req.body.olderThanDays) }),
  );

  app.get("/api/assistant/stream", { websocket: true }, (socket, req) => {
    // Without this a socket error (a phone dropping off mid-frame) reaches the
    // server's error event and takes the process down.
    socket.on("error", (err: unknown) => req.log.warn({ err }, "assistant socket error"));

    /**
     * The entries this socket was last sent, by identity.
     *
     * The thread module hands out the same array for as long as nothing has
     * been appended, so this is an O(1) answer to "has anything been said
     * since I last wrote to this socket" — and the frames in between carry no
     * entries at all. A socket that has just opened has been sent nothing, so
     * its first frame is always whole.
     */
    let sent: AssistantEntry[] | null = null;

    const send = (thread: AssistantThread) => {
      if (socket.readyState !== socket.OPEN) return;
      const frame: AssistantFrame =
        thread.entries === sent ? { ...thread, entries: undefined } : thread;
      sent = thread.entries;
      socket.send(JSON.stringify(frame));
    };

    const unsubscribe = assistant.subscribe(send);
    socket.on("close", unsubscribe);
    void assistant.readThread().then(send);
  });
}
