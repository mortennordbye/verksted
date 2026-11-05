import type { FastifyInstance } from "fastify";
import type { BrowserServerMsg, BrowserClientMsg } from "../../../shared/api.js";
import * as browser from "../browser.js";
import { barBrowsing, browsingBarred, reachedTheWeb, ruleOnCall } from "../assistant-taint.js";
import { handle } from "./browser.js";

/**
 * The chair's own browser pane: the same protocol as a session's
 * (ws/browser.ts), against the one fixed id/port in browser.ts instead of a
 * session's. No liveness check to make first — this browser is not owned by
 * a session that can end, so ensureBrowser is always the right call.
 */
export default async function assistantBrowserRoutes(app: FastifyInstance) {
  /**
   * Said by the MCP server before it serves the chair anything of the person's.
   * The browser goes, and stays gone for the rest of that turn: see
   * assistant-taint.ts for why a turn may hold one half or the other.
   *
   * Nothing reads a body here but the turn id, and the turn id comes from the
   * environment the backend wrote — not from anything a model can say.
   */
  app.post<{ Body: { turn: string } }>(
    "/api/assistant/turn/private",
    {
      schema: {
        body: {
          type: "object",
          required: ["turn"],
          additionalProperties: false,
          properties: { turn: { type: "string", maxLength: 100 } },
        },
      },
    },
    async (req, reply) => {
      // The other direction, for the tools that cannot be taken back: WebFetch
      // and WebSearch are on the CLI's command line, fixed when the turn was
      // spawned, so a turn that has already fetched something is refused the
      // read instead. The chair is told to do the two in separate turns.
      if (reachedTheWeb(req.body.turn)) {
        return reply.code(403).send({ error: "this turn has already reached the web" });
      }
      barBrowsing(req.body.turn);
      await browser.closeBrowser(browser.ASSISTANT_BROWSER_ID);
      return { browsing: "closed" };
    },
  );

  /**
   * The PreToolUse hook of every assistant turn, asked before a web or private
   * call runs. Its config sets `onFailure: "block"`, so a backend that is down or
   * answers an error refuses the call rather than letting it through.
   *
   * The turn id is a header filled from the environment the backend wrote, so
   * nothing a model can say reaches it, and the tool name is the one the CLI is
   * about to run.
   */
  app.post<{ Body: { tool_name: string } }>(
    "/api/assistant/turn/gate",
    {
      schema: {
        body: {
          type: "object",
          required: ["tool_name"],
          properties: { tool_name: { type: "string", maxLength: 200 } },
        },
      },
    },
    async (req, reply) => {
      const turn = req.headers["x-vk-turn"];
      if (typeof turn !== "string" || !turn) {
        return reply.code(403).send({ error: "no turn" });
      }
      const ruling = ruleOnCall(turn, req.body.tool_name);
      if (!ruling.allow) {
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: ruling.reason,
          },
        };
      }
      // Before the answer, as for the MCP server's own private reads. A browser
      // that will not close is a read that does not happen.
      if (ruling.closeBrowser) await browser.closeBrowser(browser.ASSISTANT_BROWSER_ID);
      return {};
    },
  );

  app.post("/api/assistant/browser/start", async (req, reply) => {
    // The turn that has read the mail does not get a browser back by asking
    // again. A person opening the pane themselves carries no turn id and is
    // unaffected.
    const turn = req.headers["x-vk-turn"] as string | undefined;
    if (browsingBarred(turn)) {
      return reply.code(403).send({ error: "this turn has read something private" });
    }
    // Not counted as reaching the web. The CLI starts every MCP server before
    // it asks the model anything, so this runs at the start of every chair
    // turn, and counting it refused each of them the calendar and the mail
    // before a word was said. A browser call is what counts (noteTool).
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
