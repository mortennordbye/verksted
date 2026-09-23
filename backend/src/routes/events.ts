import type { Writable } from "node:stream";
import type { FastifyInstance } from "fastify";
import { subscribe } from "../events.js";

/**
 * Idle keep-alive, and the client's proof that the stream is still delivering.
 *
 * A named event rather than the comment line this was: a comment keeps an
 * intermediary from dropping a quiet connection, but EventSource never surfaces
 * it, so the client had nothing to tell "nothing has changed" apart from "this
 * connection is dead" and gave up on the stream eight seconds after every open.
 * The topics are published only on change, and on a quiet bench that is never.
 */
const PING_MS = 10_000;

/**
 * How many streams at once. A tab holds one and the app runs on a handful of
 * devices; past this it is a page reconnecting in a loop or something on the
 * VPN that is not the app, and each one is a subscriber every publish writes to.
 */
const MAX_STREAMS = 32;

/**
 * How much unsent stream one client may hold before its frames are held back.
 *
 * A phone that is suspended keeps its socket and reads nothing. `write` does
 * not fail for that, it buffers, so every change on the bench was kept for it
 * in this process's memory, a whole session list at a time, until the tunnel
 * finally dropped. A frame is the whole of its topic, so holding only the
 * newest per topic loses nothing: that is all the client wanted anyway.
 */
const HIGH_WATER = 256 * 1024;
/** A client that has read nothing for this long is cut off; EventSource comes back. */
const STALLED_MS = 60_000;

/** Writes to one client, held back while it is not reading. Exported for its test. */
export function paced(res: Writable): {
  ping: () => void;
  send: (event: string, json: string, whole?: { event: string; json: string }) => void;
} {
  const clogged = () => res.writableLength > HIGH_WATER;
  const write = (topic: string, json: string) => res.write(`event: ${topic}\ndata: ${json}\n\n`);
  // The newest frame per topic that a clogged client has not been sent.
  const held = new Map<string, string>();
  let stalledSince = 0;
  res.on("drain", () => {
    stalledSince = 0;
    for (const [topic, json] of held) {
      held.delete(topic);
      write(topic, json);
      if (clogged()) break;
    }
  });
  return {
    ping: () => {
      if (!clogged()) return void write("ping", "{}");
      // No ping either: its silence is how the client learns the stream is not
      // delivering, which is true.
      stalledSince ||= Date.now();
      if (Date.now() - stalledSince > STALLED_MS) res.destroy();
    },
    send: (event, json, whole) => {
      if (!clogged() && !held.size) return void write(event, json);
      // Held back: a change on its own is only good after the ones before it,
      // so what is held is the whole answer, which is good on its own.
      if (whole) {
        held.delete(event);
        held.set(whole.event, whole.json);
      } else held.set(event, json);
    },
  };
}

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
    if (open.size >= MAX_STREAMS) {
      return reply.code(503).header("retry-after", "5").send({ error: "too many event streams" });
    }
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
    // At once, so a client that connects to a bench where nothing is happening
    // knows the stream works without waiting out a whole ping interval.
    const { ping, send } = paced(reply.raw);
    ping();

    const detach = subscribe(send);

    const pings = setInterval(ping, PING_MS);
    pings.unref?.();
    open.add(reply.raw);

    const close = () => {
      clearInterval(pings);
      open.delete(reply.raw);
      detach();
    };
    // Both ends: the client going away, and the socket erroring under us.
    req.raw.on("close", close);
    reply.raw.on("error", close);
  });
}
