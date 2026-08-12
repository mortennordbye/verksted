import type { FastifyInstance } from "fastify";
import { subscribe } from "../events.js";

/** Idle keep-alive. A comment line is a no-op to EventSource, and stops an
 *  intermediary deciding a quiet connection is a dead one. */
const PING_MS = 25_000;

export default async function eventRoutes(app: FastifyInstance) {
  /**
   * Open streams, so shutdown can end them.
   *
   * `app.close()` waits for in-flight requests to finish, and an event stream
   * never finishes by itself — a pod restart would otherwise sit there until
   * the force-exit timer in index.ts gave up on it, every time.
   */
  const open = new Set<{ end: () => void }>();
  // preClose, not onClose: onClose runs after the server has finished draining,
  // which is the very thing an open stream prevents.
  app.addHook("preClose", async () => {
    for (const res of open) res.end();
    open.clear();
  });

  /**
   * The push side of the app's state: session statuses and the project list,
   * sent when they change (see events.ts for why this exists).
   *
   * Server-sent events rather than a websocket because it is one-way and
   * EventSource reconnects itself — over a tunnel that drops when a phone
   * changes network, that reconnect is the whole feature. The Origin check in
   * app.ts covers this route too: it is a GET, so it would otherwise be the one
   * readable endpoint any page on the VPN could open cross-origin.
   */
  app.get("/api/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Ask any proxy in front not to buffer: a buffered event stream delivers
      // nothing until it is closed, which looks exactly like a broken feature.
      "x-accel-buffering": "no",
    });
    // Client-side reconnect delay, in place of EventSource's 3s default.
    reply.raw.write("retry: 2000\n\n");

    const detach = subscribe((topic, json) => {
      reply.raw.write(`event: ${topic}\ndata: ${json}\n\n`);
    });

    const ping = setInterval(() => reply.raw.write(": ping\n\n"), PING_MS);
    ping.unref?.();
    open.add(reply.raw);

    const close = () => {
      clearInterval(ping);
      open.delete(reply.raw);
      detach();
    };
    // Both ends: the client going away, and the socket erroring under us.
    req.raw.on("close", close);
    reply.raw.on("error", close);
  });
}
