import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import * as assistant from "../assistant.js";
import { readAssistantConfig, writeAssistantConfig } from "../settings-store.js";
import { MAX_CLIP_BYTES, transcribe } from "../transcribe.js";

/**
 * The assistant's thread, and the one websocket that pushes it.
 *
 * Deliberately small: a turn is a POST that returns when it is done, and the
 * socket exists so a phone watching the thread sees the turn land without
 * polling. Everything the socket sends is the whole thread, because a thread is
 * a handful of kilobytes and a diff protocol would be the only stateful thing
 * in this app.
 */
export default async function assistantRoutes(app: FastifyInstance) {
  app.get("/api/assistant", () => assistant.readThread());

  app.post<{ Body: { text: string; images?: string[] } }>(
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
          },
        },
      },
    },
    async (req, reply) => {
      const text = req.body.text.trim();
      if (!text) return reply.code(400).send({ error: "say something" });
      try {
        return await assistant.send(text, req.body.images ?? []);
      } catch (err) {
        // The only expected throw is "already running", which is a conflict
        // rather than a server fault: the client should wait, not retry.
        if (err instanceof Error && /still running/.test(err.message)) {
          return reply.code(409).send({ error: err.message });
        }
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
        req.log.error(err, "transcription failed");
        return reply.code(502).send({ error: "could not transcribe that" });
      }
    },
  );

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

  app.post("/api/assistant/stop", () => ({ stopped: assistant.stop() }));

  app.post("/api/assistant/new", async (_req, reply) => {
    try {
      return { conversationId: await assistant.newConversation() };
    } catch (err) {
      return reply.code(409).send({ error: (err as Error).message });
    }
  });

  app.get("/api/assistant/stream", { websocket: true }, (socket, req) => {
    // Without this a socket error (a phone dropping off mid-frame) reaches the
    // server's error event and takes the process down.
    socket.on("error", (err: unknown) => req.log.warn({ err }, "assistant socket error"));
    const unsubscribe = assistant.subscribe((thread) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(thread));
    });
    socket.on("close", unsubscribe);
    void assistant.readThread().then((thread) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(thread));
    });
  });
}
