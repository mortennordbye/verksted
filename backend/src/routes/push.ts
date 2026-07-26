import type { FastifyInstance } from "fastify";
import type { PushStatus, PushTestResult } from "../../../shared/api.js";
import * as push from "../push-store.js";

// Endpoints are opaque URLs owned by the browser's push service (Apple, Google,
// Mozilla); the only thing worth insisting on is that they are https URLs of a
// sane length. The keys are base64url blobs we never interpret ourselves.
const subscription = {
  type: "object",
  required: ["endpoint", "keys"],
  additionalProperties: false,
  properties: {
    endpoint: { type: "string", maxLength: 1024, pattern: "^https://" },
    keys: {
      type: "object",
      required: ["p256dh", "auth"],
      additionalProperties: false,
      properties: {
        p256dh: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9_=-]+$" },
        auth: { type: "string", maxLength: 256, pattern: "^[A-Za-z0-9_=-]+$" },
      },
    },
  },
};

export default async function pushRoutes(app: FastifyInstance) {
  app.get("/api/push", async (): Promise<PushStatus> => ({
    publicKey: await push.publicKey(),
    devices: await push.deviceCount(),
  }));

  app.post<{ Body: { endpoint: string; keys: { p256dh: string; auth: string } } }>(
    "/api/push/subscribe",
    { schema: { body: subscription } },
    async (req, reply) => {
      try {
        await push.subscribe(req.body, String(req.headers["user-agent"] ?? "unknown device"));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      return { devices: await push.deviceCount() };
    },
  );

  app.post<{ Body: { endpoint: string } }>(
    "/api/push/unsubscribe",
    {
      schema: {
        body: {
          type: "object",
          required: ["endpoint"],
          additionalProperties: false,
          properties: { endpoint: { type: "string", maxLength: 1024 } },
        },
      },
    },
    async (req) => {
      await push.unsubscribe(req.body.endpoint);
      return { devices: await push.deviceCount() };
    },
  );

  // Proves the whole chain — permission, subscription, push service, service
  // worker — without waiting for an agent to need something. Reports what the
  // push service said, so a refused push isn't indistinguishable from a phone
  // that simply stayed quiet.
  app.post("/api/push/test", async (): Promise<PushTestResult> => {
    const result = await push.send(
      { title: "verksted", body: "notifications are working", url: "/" },
      app.log,
    );
    return { devices: await push.deviceCount(), ...result };
  });
}
