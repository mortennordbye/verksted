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

export default async function attachRoutes(app: FastifyInstance) {
  app.get<{
    Params: { id: string };
    Querystring: { cols?: string; rows?: string; shell?: string };
  }>(
    "/api/sessions/:id/attach",
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      const session = await store.getSession(id);
      if (!session || session.status !== "running") {
        socket.close(4404, "no such session");
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

      const pty = spawn("tmux", args, {
        name: "xterm-256color",
        cols: clamp(req.query.cols, 2, 500, 80),
        rows: clamp(req.query.rows, 2, 300, 24),
        cwd: env.REPOS_DIR,
        env: tmux.UTF8_ENV as Record<string, string>,
      });

      pty.onData((data) => socket.send(data));
      // Session killed elsewhere (or tmux exited): drop the socket.
      pty.onExit(() => socket.close(1000));

      // An agent waiting for input produces zero traffic; protocol-level pings
      // (answered by the browser automatically) keep idle connections alive
      // through proxies. The tmux session itself never times out either way.
      const keepalive = setInterval(() => socket.ping(), 30_000);

      socket.on("message", (raw: Buffer) => {
        let msg: WsClientMsg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.t === "in" && typeof msg.data === "string") {
          pty.write(msg.data);
        } else if (msg.t === "resize") {
          pty.resize(clamp(msg.cols, 2, 500, 80), clamp(msg.rows, 2, 300, 24));
        }
      });

      // Detach, never kill: this ends only the `tmux attach` client process.
      // The tmux session and the agent inside it keep running.
      socket.on("close", () => {
        clearInterval(keepalive);
        pty.kill();
      });
    },
  );
}
