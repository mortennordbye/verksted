import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import * as feed from "../feed-store.js";

/**
 * Intake: getting something to the assistant from outside the app.
 *
 * A link, a paragraph, a title: whatever the phone's share sheet or a
 * Shortcut posts lands as a feed item marked as yours, and the next triage
 * turn reads it like anything else. On Android the manifest's share target
 * points the browser here through the /share screen; on iOS a Shortcut
 * posts JSON to this endpoint over the tunnel. Photos go through the chat's
 * own attach button, which already reads them.
 */
export default async function intakeRoutes(app: FastifyInstance) {
  app.post<{ Body: { title?: string; text?: string; url?: string } }>(
    "/api/intake",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string", maxLength: 300 },
            text: { type: "string", maxLength: 20_000 },
            url: { type: "string", maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const title = req.body.title?.trim() ?? "";
      const text = req.body.text?.trim() ?? "";
      const url = req.body.url?.trim() ?? "";
      if (!title && !text && !url) return reply.code(400).send({ error: "nothing to take in" });
      const link = /^https?:\/\//.test(url) ? url : null;
      const id = `intake:${randomUUID()}`;
      const { item } = await feed.upsert({
        id,
        source: "intake",
        at: new Date().toISOString(),
        title: `from you: ${title || text.split("\n")[0].slice(0, 120) || url}`,
        detail: [text, link ?? url].filter(Boolean).join("\n").slice(0, 4000),
        link,
        version: "shared",
      });
      return reply.code(201).send(item);
    },
  );
}
