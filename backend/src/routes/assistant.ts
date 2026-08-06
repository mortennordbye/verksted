import type { FastifyInstance } from "fastify";
import * as assistant from "../assistant.js";

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

  app.post<{ Body: { text: string } }>(
    "/api/assistant/messages",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          // Long enough to paste an error into, short enough that a runaway
          // client cannot put a megabyte on the volume in one call.
          properties: { text: { type: "string", minLength: 1, maxLength: 20_000 } },
        },
      },
    },
    async (req, reply) => {
      const text = req.body.text.trim();
      if (!text) return reply.code(400).send({ error: "say something" });
      try {
        return await assistant.send(text);
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
