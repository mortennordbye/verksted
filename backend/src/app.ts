import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { env } from "./env.js";
import { isWebsocketUpgrade, needsOriginCheck, originAllowed } from "./origin.js";
import projectRoutes from "./routes/projects.js";
import sessionRoutes from "./routes/sessions.js";
import fileRoutes from "./routes/files.js";
import factsRoutes from "./routes/facts.js";
import settingsRoutes from "./routes/settings.js";
import scheduleRoutes from "./routes/schedules.js";
import sshRoutes from "./routes/ssh.js";
import pushRoutes from "./routes/push.js";
import githubRoutes from "./routes/github.js";
import assistantRoutes from "./routes/assistant.js";
import attachRoutes from "./ws/attach.js";
import browserRoutes from "./ws/browser.js";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    // The default request serializer logs the full url. Query strings here carry
    // repo paths and search terms, so log only the path and let LOG_LEVEL turn
    // request logging off entirely.
    logger:
      opts.logger === false
        ? false
        : {
            level: process.env.LOG_LEVEL ?? "info",
            serializers: {
              req: (req) => ({
                method: req.method,
                url: req.url.split("?")[0],
                remoteAddress: req.socket?.remoteAddress,
              }),
            },
          },
  });

  // Deny cross-origin state changes and websocket upgrades before any route
  // sees them; see origin.ts for why this stands in for CORS.
  app.addHook("onRequest", async (req, reply) => {
    if (!needsOriginCheck(req) || originAllowed(req)) return;
    req.log.warn({ origin: req.headers.origin }, "blocked cross-origin request");

    if (isWebsocketUpgrade(req)) {
      // A refused handshake needs the socket closed by hand. The client is
      // waiting for a 101 and the connection never enters keep-alive, so a
      // plain reply would leave it half-open until the OS gives up — a free
      // socket leak for anything that keeps trying.
      req.raw.socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return reply.hijack();
    }
    return reply.code(403).send({ error: "origin not allowed" });
  });

  await app.register(websocket);
  await app.register(projectRoutes);
  await app.register(sessionRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
  await app.register(scheduleRoutes);
  await app.register(factsRoutes);
  await app.register(sshRoutes);
  await app.register(pushRoutes);
  await app.register(githubRoutes);
  await app.register(assistantRoutes);
  await app.register(attachRoutes);
  await app.register(browserRoutes);

  app.get("/api/health", async () => ({ ok: true }));

  if (env.STATIC_DIR && fs.existsSync(env.STATIC_DIR)) {
    await app.register(fastifyStatic, { root: env.STATIC_DIR });
    // SPA fallback: any non-API GET serves index.html.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/")) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: "not found" });
    });
  }

  return app;
}
