import type { FastifyInstance } from "fastify";
import type { BrowserClientMsg, BrowserServerMsg } from "../../../shared/api.js";
import * as browser from "../browser.js";
import * as store from "../sessions-store.js";

function clamp(n: unknown, min: number, max: number): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}

export default async function browserRoutes(app: FastifyInstance) {
  // Boots the session's browser and returns its CDP endpoint. The agent inside
  // the session can call this (curl) before connecting to $VK_BROWSER_CDP.
  app.post<{ Params: { id: string } }>("/api/sessions/:id/browser/start", async (req, reply) => {
    const session = await store.getSession(req.params.id);
    if (!session || session.status === "done") {
      return reply.code(404).send({ error: "not found" });
    }
    const port = await store.cdpPortFor(req.params.id);
    if (!port) return reply.code(409).send({ error: "no browser port" });
    try {
      await browser.ensureBrowser(req.params.id, port);
    } catch (err) {
      req.log.error(err, "browser launch failed");
      return reply.code(502).send({ error: "browser launch failed" });
    }
    return { cdpUrl: `http://127.0.0.1:${port}` };
  });

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/browser",
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      const session = await store.getSession(id);
      if (!session || session.status === "done") {
        socket.close(4404, "no such session");
        return;
      }
      const port = await store.cdpPortFor(id);
      if (!port) {
        socket.close(4409, "no browser port");
        return;
      }
      let entry: browser.BrowserEntry;
      try {
        entry = await browser.ensureBrowser(id, port);
      } catch (err) {
        req.log.error(err, "browser launch failed");
        socket.close(4502, "browser launch failed");
        return;
      }

      const listener = (msg: BrowserServerMsg) => {
        // Drop frames when the client is behind; input/url messages are tiny.
        if (msg.t === "frame" && socket.bufferedAmount > 1_000_000) return;
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      };
      await browser.addListener(entry, listener);

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
        void browser.removeListener(entry, listener);
      });
    },
  );
}

async function handle(
  entry: browser.BrowserEntry,
  msg: BrowserClientMsg,
  reply: (m: BrowserServerMsg) => void,
): Promise<void> {
  const page = entry.current;
  switch (msg.t) {
    case "nav": {
      const url = browser.validNavUrl(String(msg.url ?? ""));
      if (!url) return reply({ t: "error", message: "invalid url" });
      await page.goto(url, { waitUntil: "commit", timeout: 20_000 }).catch((err: Error) => {
        reply({ t: "error", message: err.message.split("\n")[0]!.slice(0, 200) });
      });
      return;
    }
    case "back":
      await page.goBack({ waitUntil: "commit" }).catch(() => {});
      return;
    case "forward":
      await page.goForward({ waitUntil: "commit" }).catch(() => {});
      return;
    case "reload":
      await page.reload({ waitUntil: "commit" }).catch(() => {});
      return;
    case "resize":
      await page
        .setViewportSize({
          width: clamp(msg.width, 100, 2400),
          height: clamp(msg.height, 100, 1600),
        })
        .catch(() => {});
      return;
    case "mouse":
      if (!entry.cdp) return;
      await entry.cdp
        .send("Input.dispatchMouseEvent", {
          type: msg.type,
          x: clamp(msg.x, 0, 10_000),
          y: clamp(msg.y, 0, 10_000),
          button: msg.button ?? "none",
          clickCount: clamp(msg.clickCount ?? 0, 0, 3),
          deltaX: clamp(msg.deltaX ?? 0, -4000, 4000),
          deltaY: clamp(msg.deltaY ?? 0, -4000, 4000),
          modifiers: clamp(msg.modifiers ?? 0, 0, 15),
        })
        .catch(() => {});
      return;
    case "key":
      if (!entry.cdp) return;
      await entry.cdp
        .send("Input.dispatchKeyEvent", {
          // CDP: "keyDown" (with text) produces character input, "rawKeyDown" doesn't.
          type: msg.type === "keyUp" ? "keyUp" : msg.text ? "keyDown" : "rawKeyDown",
          key: String(msg.key ?? "").slice(0, 32),
          code: String(msg.code ?? "").slice(0, 32),
          text: msg.text?.slice(0, 8),
          windowsVirtualKeyCode: clamp(msg.keyCode, 0, 255),
          nativeVirtualKeyCode: clamp(msg.keyCode, 0, 255),
          modifiers: clamp(msg.modifiers ?? 0, 0, 15),
        })
        .catch(() => {});
      return;
  }
}
