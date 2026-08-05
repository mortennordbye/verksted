import type { FastifyInstance } from "fastify";
import { spawn } from "node-pty";
import type { WsClientMsg } from "../../../shared/api.js";
import { env } from "../env.js";
import { resolveInsideRepos } from "../paths.js";
import * as store from "../sessions-store.js";
import { agentEnv } from "../settings-store.js";
import * as tmux from "../tmux.js";

function clamp(n: unknown, min: number, max: number, def: number): number {
  const v = Number(n);
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
}

/**
 * Attach clients per session. Each one is a `tmux attach` process plus a ping
 * interval, so a page that reconnects in a loop (or a handful of forgotten
 * phone tabs) quietly multiplies both. Well above what a person opens on
 * purpose: a phone, a desktop, and room to reconnect before the dead one's
 * missed pong drops it.
 */
const MAX_CLIENTS_PER_SESSION = 6;
const clientCount = new Map<string, number>();

export default async function attachRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { cols?: string; rows?: string; shell?: string };
  }>(
    "/api/sessions/:id/attach",
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      // Without this a socket error (a phone dropping off mid-frame) reaches
      // the server's error event and takes the process down.
      socket.on("error", (err: unknown) => req.log.warn({ err, id }, "attach socket error"));

      const session = await store.getSession(id);
      if (!session || session.status === "done") {
        socket.close(4404, "no such session");
        return;
      }
      if ((clientCount.get(id) ?? 0) >= MAX_CLIENTS_PER_SESSION) {
        socket.close(4429, "too many clients");
        return;
      }

      // shell=1 attaches a companion tmux session (plain shell in the project
      // dir) instead of the agent session, creating it on first use. It is
      // killed together with the agent session in sessions-store.
      // "-u" forces UTF-8 for this client even if the locale is misdetected.
      let args: string[];
      if (req.query.shell === "1") {
        let projectDir: string;
        try {
          projectDir = resolveInsideRepos(session.project);
        } catch {
          socket.close(4404, "no such session");
          return;
        }
        args = [
          "-u",
          "new-session",
          "-A",
          "-s",
          `${id}-shell`,
          "-c",
          projectDir,
          ...tmux.envArgs(await agentEnv()),
        ];
      } else {
        // "=" pins tmux to the exact name — never prefix-match the companion.
        args = ["-u", "attach-session", "-t", `=${id}`];
      }

      // node-pty throws synchronously when it cannot fork, which inside an async
      // websocket handler would surface as an unhandled rejection rather than a
      // closed socket.
      let pty: ReturnType<typeof spawn>;
      try {
        pty = spawn("tmux", args, {
          name: "xterm-256color",
          cols: clamp(req.query.cols, 2, 500, 80),
          rows: clamp(req.query.rows, 2, 300, 24),
          cwd: env.REPOS_DIR,
          env: tmux.UTF8_ENV,
        });
      } catch (err) {
        req.log.error({ err, id }, "could not attach to tmux");
        socket.close(4500, "could not attach");
        return;
      }
      clientCount.set(id, (clientCount.get(id) ?? 0) + 1);

      pty.onData((data) => socket.send(data));
      // Session killed elsewhere (or tmux exited): drop the socket.
      pty.onExit(() => socket.close(1000));

      // An agent waiting for input produces zero traffic; protocol-level pings
      // (answered by the browser automatically) keep idle connections alive
      // through proxies. The tmux session itself never times out either way.
      //
      // The pong is also how a client that went away without closing is found:
      // iOS freezes a backgrounded PWA's socket, and TCP alone takes many
      // minutes to notice, leaving a `tmux attach` client per suspension. A
      // missed pong drops it — the tmux session is untouched, and a phone that
      // comes back simply reconnects.
      let answered = true;
      socket.on("pong", () => {
        answered = true;
      });
      const keepalive = setInterval(() => {
        if (!answered) return socket.terminate();
        answered = false;
        socket.ping();
      }, 30_000);

      // Scrolling puts the pane into tmux copy mode, where keystrokes are copy
      // bindings rather than input — so the next input has to leave it first.
      // The queue keeps that cancel (a tmux exec) ordered ahead of the
      // keystroke that triggered it; without it the key would race the exec
      // and be swallowed by copy mode.
      const target = req.query.shell === "1" ? `${id}-shell` : id;
      let scrolled = false;
      let queue: Promise<unknown> = Promise.resolve();
      const enqueue = (step: () => unknown) => {
        queue = queue.then(step).catch(() => {});
      };

      socket.on("message", (raw: Buffer) => {
        let msg: WsClientMsg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === "in" && typeof msg.data === "string") {
          if (scrolled) {
            scrolled = false;
            enqueue(() => tmux.exitCopyMode(target));
          }
          enqueue(() => pty.write(msg.data));
        } else if (msg.t === "resize") {
          pty.resize(clamp(msg.cols, 2, 500, 80), clamp(msg.rows, 2, 300, 24));
        } else if (msg.t === "scroll") {
          const lines = clamp(msg.lines, -500, 500, 0);
          if (lines === 0) return;
          scrolled = true;
          enqueue(() => tmux.scrollHistory(target, lines));
        }
      });

      // Detach, never kill: this ends only the `tmux attach` client process.
      // The tmux session and the agent inside it keep running.
      socket.on("close", () => {
        clearInterval(keepalive);
        const left = (clientCount.get(id) ?? 1) - 1;
        if (left > 0) clientCount.set(id, left);
        else clientCount.delete(id);
        pty.kill();
      });
    },
  );
}
