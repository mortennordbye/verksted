import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin, tmuxLsRows } from "./helpers/fake-bin.js";

/**
 * R-23: a resize that lands on a terminal whose process has gone.
 *
 * node-pty throws from `resize` then, and thrown from a socket listener it
 * reaches nothing but the process: on the pod, every agent in every tmux
 * session. The real race needs the resize and the exit in the same tick, which
 * a test cannot arrange honestly, so the pty here is a stub whose resize
 * always throws. What is asserted is what the guard is for: the backend lives,
 * and the same socket still carries keystrokes afterwards.
 */

const pty = vi.hoisted(() => ({ spawned: 0, written: [] as string[], resizes: 0 }));

vi.mock("node-pty", () => ({
  spawn: () => {
    pty.spawned++;
    return {
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      pause: () => {},
      resume: () => {},
      write: (data: string) => pty.written.push(data),
      resize: () => {
        pty.resizes++;
        throw new Error("ioctl(2) failed, EBADF");
      },
      kill: () => {},
    };
  },
}));

const SESSION = "vk-demo-1";
let app: FastifyInstance;
let port: number;
let fake: FakeBin;

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);
  fake.reply("tmux", "ls", { stdout: tmuxLsRows(SESSION) });
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-resize-"));
  fs.writeFileSync(
    path.join(sessionsDir, `${SESSION}.json`),
    JSON.stringify({
      id: SESSION,
      project: "demo",
      agent: "claude",
      title: "a session on a phone that rotates",
      createdAt: new Date().toISOString(),
    }),
  );
  const reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  fs.mkdirSync(path.join(reposDir, "demo"));
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.REPOS_DIR = reposDir;
  process.env.STATIC_DIR = "";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

describe("a resize on a terminal that has gone", () => {
  it("is logged and dropped, and the socket goes on carrying keystrokes", async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${SESSION}/attach`);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    let closed = false;
    socket.addEventListener("close", () => (closed = true));
    // The route listens for messages once it has its pty, not on open.
    await vi.waitFor(() => expect(pty.spawned).toBe(1));

    socket.send(JSON.stringify({ t: "resize", cols: 100, rows: 40 }));
    socket.send(JSON.stringify({ t: "in", data: "still here" }));

    await vi.waitFor(() => expect(pty.written).toEqual(["still here"]));
    expect(pty.resizes).toBe(1);
    expect(closed).toBe(false);
    socket.close();
  });
});
