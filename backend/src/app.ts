import fs from "node:fs";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { env } from "./env.js";
import projectRoutes from "./routes/projects.js";
import sessionRoutes from "./routes/sessions.js";
import fileRoutes from "./routes/files.js";
import factsRoutes from "./routes/facts.js";
import settingsRoutes from "./routes/settings.js";
import sshRoutes from "./routes/ssh.js";
import attachRoutes from "./ws/attach.js";
import browserRoutes from "./ws/browser.js";

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(websocket);
  await app.register(projectRoutes);
  await app.register(sessionRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
  await app.register(factsRoutes);
  await app.register(sshRoutes);
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
