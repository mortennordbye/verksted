import fs from "node:fs";
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import helmet from "@fastify/helmet";
import { env } from "./env.js";
import { hostAllowed, isWebsocketUpgrade, needsOriginCheck, originAllowed } from "./origin.js";
import projectRoutes from "./routes/projects.js";
import sessionRoutes from "./routes/sessions.js";
import fileRoutes from "./routes/files.js";
import eventRoutes from "./routes/events.js";
import factsRoutes from "./routes/facts.js";
import usageRoutes from "./routes/usage.js";
import maintainerRoutes from "./routes/maintainer.js";
import clusterRoutes from "./routes/cluster.js";
import settingsRoutes from "./routes/settings.js";
import scheduleRoutes from "./routes/schedules.js";
import sshRoutes from "./routes/ssh.js";
import pushRoutes from "./routes/push.js";
import backupRoutes from "./routes/backups.js";
import githubRoutes from "./routes/github.js";
import feedbackRoutes from "./routes/feedback.js";
import assistantRoutes from "./routes/assistant.js";
import memoryRoutes from "./routes/memory.js";
import profileRoutes from "./routes/profile.js";
import feedRoutes from "./routes/feed.js";
import sourceRoutes from "./routes/sources.js";
import googleRoutes from "./routes/google.js";
import proposalRoutes from "./routes/proposals.js";
import intakeRoutes from "./routes/intake.js";
import docsRoutes from "./routes/docs.js";
import councilRoutes from "./routes/council.js";
import attachRoutes from "./ws/attach.js";
import assistantBrowserRoutes from "./ws/assistant-browser.js";
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

  /**
   * A refused request the browser is waiting on. A websocket handshake needs
   * the socket closed by hand: the client is waiting for a 101 and the
   * connection never enters keep-alive, so a plain reply would leave it
   * half-open until the OS gives up — a free socket leak for anything that
   * keeps trying.
   */
  const refuse = (req: FastifyRequest, reply: FastifyReply, why: string) => {
    if (isWebsocketUpgrade(req)) {
      req.raw.socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return reply.hijack();
    }
    return reply.code(403).send({ error: why });
  };

  // Every request, read or write: the name it was addressed to has to be one
  // this deployment answers for, or the origin check below is satisfied by DNS
  // rebinding. See origin.ts.
  app.addHook("onRequest", async (req, reply) => {
    if (hostAllowed(req)) return;
    req.log.warn({ host: req.headers.host }, "blocked request for an unknown host");
    return refuse(req, reply, "host not allowed");
  });

  // Deny cross-origin state changes and websocket upgrades before any route
  // sees them; see origin.ts for why this stands in for CORS.
  app.addHook("onRequest", async (req, reply) => {
    if (!needsOriginCheck(req) || originAllowed(req)) return;
    req.log.warn({ origin: req.headers.origin }, "blocked cross-origin request");
    return refuse(req, reply, "origin not allowed");
  });

  /**
   * One error shape, and nothing internal in it.
   *
   * Without a handler here Fastify answers a thrown error with its message:
   * `createSession` rejecting reports `Command failed: tmux new-session ... -e
   * GH_TOKEN=ghp_...` straight to the client, and every route that awaits a
   * child process is the same story. 4xx keeps its message — a schema
   * rejection is about the request, and the client shows it — while 5xx says
   * only that something broke and the detail stays in the log.
   */
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, "request failed");
      return reply.code(status).send({ error: "internal error" });
    }
    return reply.code(status).send({ error: err.message });
  });

  /**
   * Security headers. frame-ancestors is the one that matters most: without it
   * any page can frame the app invisibly and steer taps onto "do", "force
   * push" or "delete project" — no cookie needed, because there is no auth to
   * carry. The CSP is the second layer under the markdown image rule (C-04):
   * a reply written after reading a mail cannot carry what it read out in an
   * image URL. 'unsafe-inline' for styles is xterm, which writes its own.
   */
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "media-src": ["'self'", "data:", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", "ws:", "wss:"],
        "worker-src": ["'self'", "blob:"],
        // 'self', not 'none': the document viewer frames /api/docs/raw to let
        // the browser draw a PDF. Cross-site framing is what this is for.
        "frame-ancestors": ["'self'"],
        "base-uri": ["'self'"],
        "form-action": ["'self'"],
        "object-src": ["'none'"],
        // The app is served over http inside the pod; the ingress terminates
        // TLS in front of it, so upgrading requests would break `make run`.
        "upgrade-insecure-requests": null,
      },
    },
    // A cross-site page could otherwise embed /api/docs/raw as an image and
    // learn that a document exists and how big it is.
    crossOriginResourcePolicy: { policy: "same-origin" },
    // The pane streams a session's browser; COEP would break nothing today but
    // it also gains nothing here, and it blocks cross-origin images outright.
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    hsts: env.PUBLIC_URL.startsWith("https://")
      ? { maxAge: 15_552_000, includeSubDomains: true }
      : false,
  });

  await app.register(websocket);
  await app.register(projectRoutes);
  await app.register(sessionRoutes);
  await app.register(fileRoutes);
  await app.register(settingsRoutes);
  await app.register(scheduleRoutes);
  await app.register(factsRoutes);
  await app.register(usageRoutes);
  await app.register(maintainerRoutes);
  await app.register(clusterRoutes);
  await app.register(eventRoutes);
  await app.register(sshRoutes);
  await app.register(pushRoutes);
  await app.register(backupRoutes);
  await app.register(githubRoutes);
  // A note filed by `vk feedback` is the whole request body, as plain text —
  // see routes/feedback.ts for why a shell client is not asked to write JSON.
  app.addContentTypeParser("text/plain", { parseAs: "string" }, (_req, body, done) =>
    done(null, body),
  );
  await app.register(feedbackRoutes);
  // Raw image bodies for the assistant's upload endpoint (the same shape the
  // per-project upload uses; a phone has no clipboard to paste a screenshot from).
  // Recorded audio for the transcribe endpoint; the container type depends on
  // the browser (webm/opus on Chrome, mp4/aac on Safari), and ffmpeg sniffs the
  // real one anyway, so every one of them is taken as raw bytes.
  for (const mime of [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "audio/webm",
    "audio/ogg",
    "audio/mp4",
    "audio/mpeg",
    "audio/wav",
  ]) {
    app.addContentTypeParser(mime, { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  }
  await app.register(assistantRoutes);
  await app.register(memoryRoutes);
  await app.register(profileRoutes);
  await app.register(feedRoutes);
  await app.register(sourceRoutes);
  await app.register(googleRoutes);
  await app.register(proposalRoutes);
  await app.register(intakeRoutes);
  await app.register(docsRoutes);
  await app.register(councilRoutes);
  await app.register(attachRoutes);
  await app.register(browserRoutes);
  await app.register(assistantBrowserRoutes);

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
