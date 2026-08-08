import type { FastifyInstance } from "fastify";
import type { PushStatus, PushTestResult } from "../../../shared/api.js";
import { announce } from "../notifier.js";
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

/**
 * How long the same notification stays suppressed.
 *
 * This endpoint has exactly one caller — the assistant's `notify` tool — and
 * the caller that made it necessary is a schedule: an unattended turn starts a
 * fresh conversation every time, so it cannot remember pushing "main is red" an
 * hour ago and will happily push it again on every tick. Long enough that a
 * standing problem interrupts once a morning rather than once an hour, short
 * enough that a thing still broken tomorrow says so again.
 *
 * In memory on purpose: a restart losing this costs one duplicate push, and a
 * file on the volume for it would be state this app otherwise does not keep.
 */
const REPEAT_WINDOW_MS = 6 * 60 * 60_000;
const recentPushes = new Map<string, number>();

/** True when this exact message went out inside the window; stamps it if not. */
function repeated(key: string, now = Date.now()): boolean {
  for (const [k, at] of recentPushes) if (now - at > REPEAT_WINDOW_MS) recentPushes.delete(k);
  const last = recentPushes.get(key);
  if (last !== undefined && now - last <= REPEAT_WINDOW_MS) return true;
  recentPushes.set(key, now);
  return false;
}

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

  /**
   * Send one message to the phone. The assistant's way of reaching someone who
   * is not looking at the chat, which until now only the session notifier could
   * do — an agent could notice a failed run and had no way to say so.
   *
   * `url` is where tapping it lands, and it is restricted to a path inside this
   * app: a push notification is the one surface here that renders somewhere the
   * app does not control, so an arbitrary link in it would be a phishing link
   * with verksted's name on it.
   */
  app.post<{ Body: { title?: string; body: string; url?: string } }>(
    "/api/push/send",
    {
      schema: {
        body: {
          type: "object",
          required: ["body"],
          additionalProperties: false,
          properties: {
            title: { type: "string", minLength: 1, maxLength: 100 },
            body: { type: "string", minLength: 1, maxLength: 500 },
            url: { type: "string", maxLength: 200, pattern: "^/[^/].*$|^/$" },
          },
        },
      },
    },
    async (req): Promise<PushTestResult> => {
      const message = {
        title: req.body.title ?? "verksted",
        body: req.body.body,
        url: req.body.url ?? "/",
        tag: "bell" as const,
      };
      const devices = await push.deviceCount();
      if (repeated(`${message.title}\n${message.body}\n${message.url}`)) {
        return { devices, sent: 0, failed: 0, suppressed: true };
      }
      return { devices, ...(await announce(message, app.log)) };
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
