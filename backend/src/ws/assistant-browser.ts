import type { FastifyInstance } from "fastify";
import type { BrowserServerMsg, BrowserClientMsg } from "../../../shared/api.js";
import * as browser from "../browser.js";
import { handle } from "./browser.js";

/**
 * The chair's own browser pane: the same protocol as a session's
 * (ws/browser.ts), against the one fixed id/port in browser.ts instead of a
 * session's. No liveness check to make first — this browser is not owned by
 * a session that can end, so ensureBrowser is always the right call.
 */
export default async function assistantBrowserRoutes(app: FastifyInstance) {
  app.post("/api/assistant/browser/start", async (req, reply) => {
    try {
      await browser.ensureBrowser(browser.ASSISTANT_BROWSER_ID, browser.ASSISTANT_CDP_PORT);
    } catch (err) {
      req.log.error(err, "assistant browser launch failed");
      return reply.code(502).send({ error: "browser launch failed" });
    }
    return { cdpUrl: `http://127.0.0.1:${browser.ASSISTANT_CDP_PORT}` };
  });

  app.get("/api/assistant/browser", { websocket: true }, async (socket, req) => {
    socket.on("error", (err: unknown) => req.log.warn({ err }, "assistant browser socket error"));

    let entry: browser.BrowserEntry;
    try {
      entry = await browser.ensureBrowser(browser.ASSISTANT_BROWSER_ID, browser.ASSISTANT_CDP_PORT);
    } catch (err) {
      req.log.error(err, "assistant browser launch failed");
      socket.close(4502, "browser launch failed");
      return;
    }

    const listener = (msg: BrowserServerMsg) => {
      if (msg.t === "frame" && socket.bufferedAmount > 1_000_000) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };
    await browser.addListener(entry, listener);

    let answered = true;
    socket.on("pong", () => {
      answered = true;
    });
    const keepalive = setInterval(() => {
      if (!answered) return socket.terminate();
      answered = false;
      socket.ping();
    }, 30_000);

    socket.on("message", (raw: Buffer) => {
      if (raw.length > 4096) return;
      let msg: BrowserClientMsg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      void handle(entry, msg, listener).catch(() => {});
    });

    socket.on("close", () => {
      clearInterval(keepalive);
      void browser.removeListener(entry, listener);
    });
  });
}
