import type { FastifyInstance } from "fastify";
import { spawn } from "node-pty";
import type { WsClientMsg } from "../../../shared/api.js";
import { env } from "../env.js";
import * as store from "../sessions-store.js";

function clamp(n: unknown, min: number, max: number, def: number): number {
  const v = Number(n);
  return Number.isInteger(v) && v >= min && v <= max ? v : def;
}

export default async function attachRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string }; Querystring: { cols?: string; rows?: string } }>(
    "/api/sessions/:id/attach",
    { websocket: true },
    async (socket, req) => {
      const { id } = req.params;
      const session = await store.getSession(id);
      if (!session || session.status !== "running") {
        socket.close(4404, "no such session");
        return;
      }

      const pty = spawn("tmux", ["attach-session", "-t", id], {
        name: "xterm-256color",
        cols: clamp(req.query.cols, 2, 500, 80),
        rows: clamp(req.query.rows, 2, 300, 24),
        cwd: env.REPOS_DIR,
        env: process.env as Record<string, string>,
      });

      pty.onData((data) => socket.send(data));
      // Session killed elsewhere (or tmux exited): drop the socket.
      pty.onExit(() => socket.close(1000));

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
      socket.on("close", () => pty.kill());
    },
  );
}
