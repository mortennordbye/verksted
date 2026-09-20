import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin, tmuxLsRows } from "./helpers/fake-bin.js";

/**
 * The terminal bridge driven end to end: a real pty, a real websocket, and a
 * fake tmux that stays up until something ends it.
 *
 * What it is here for is the one invariant CLAUDE.md calls the core feature —
 * closing a socket detaches the `tmux attach` client and never kills the tmux
 * session, so a phone that locks does not end a night's work. Until now that
 * was written down in three comments and asserted nowhere (O-24 in the audit).
 * A test needs to see a process die without owning it, which is what the
 * recorded pid in the fake's call log is for.
 */

let app: FastifyInstance;
let port: number;
let fake: FakeBin;

const SESSION = "vk-demo-1";

/** Open the attach socket for a session and wait until it is up. */
function open(id = SESSION, qs = ""): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/attach${qs}`);
  return new Promise((resolve, reject) => {
    socket.addEventListener("open", () => resolve(socket));
    socket.addEventListener("error", () => reject(new Error(`could not open ${id}`)));
  });
}

/** The code the server closed a socket with, for the ones it refuses. */
function closedWith(id: string): Promise<number> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/attach`);
  return new Promise((resolve) => socket.addEventListener("close", (ev) => resolve(ev.code)));
}

/** Whether a pid is gone, asked the one way that does not need to own it. */
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const attaches = () => fake.calls().filter((c) => c.argv.includes("attach-session"));
const shells = () => fake.calls().filter((c) => c.argv.includes("new-session"));

beforeAll(async () => {
  // Before the modules under test are imported: tmux.ts snapshots PATH at
  // import time, and node-pty spawns the attach client with that snapshot.
  fake = FakeBin.install(["tmux"]);
  fake.reply("tmux", "ls", { stdout: tmuxLsRows(SESSION) });
  // A real attach client lives until something ends it. These two outlive the
  // suite, so what ends them is the code under test rather than a timer.
  fake.reply("tmux", "-u attach-session", { delayMs: 60_000 });
  fake.reply("tmux", "-u new-session", { delayMs: 60_000 });

  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-attach-"));
  fs.writeFileSync(
    path.join(sessionsDir, `${SESSION}.json`),
    JSON.stringify({
      id: SESSION,
      project: "demo",
      agent: "claude",
      title: "a session somebody is watching",
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

describe("the terminal attach socket", () => {
  it("detaches its own client and leaves the session running", async () => {
    fake.reset();
    const socket = await open();
    await vi.waitFor(() => expect(attaches()).toHaveLength(1));
    const [client] = attaches();
    // "=" pins tmux to this session rather than prefix-matching the companion.
    expect(client.argv).toEqual(["-u", "attach-session", "-t", `=${SESSION}`]);

    socket.close();
    // The client process really goes — pty.kill() in the close handler.
    await vi.waitFor(() => expect(gone(client.pid)).toBe(true), { timeout: 10_000 });
    // And tmux was never asked to end anything, which is the whole point.
    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
    const res = await app.inject({ method: "GET", url: `/api/sessions/${SESSION}` });
    expect(res.json().status).toBe("running");
  });

  it("gives a shell pane a companion session, never the agent's", async () => {
    fake.reset();
    const socket = await open(SESSION, "?shell=1");
    await vi.waitFor(() => expect(shells()).toHaveLength(1));
    const [client] = shells();
    expect(client.argv.slice(0, 5)).toEqual(["-u", "new-session", "-A", "-s", `${SESSION}-shell`]);
    // The agent's own session is not named anywhere in that call.
    expect(client.argv.join(" ")).not.toContain(`=${SESSION}`);

    socket.close();
    await vi.waitFor(() => expect(gone(client.pid)).toBe(true), { timeout: 10_000 });
    expect(fake.subcommand("tmux", "kill-session")).toEqual([]);
  });

  it("refuses a session it does not have without spawning anything", async () => {
    fake.reset();
    expect(await closedWith("vk-nope-1")).toBe(4404);
    expect(attaches()).toEqual([]);
  });

  it("caps the clients on one session rather than multiplying attach processes", async () => {
    // Six is what a phone, a desktop and room to reconnect need; a page
    // reconnecting in a loop would otherwise leave a tmux client per attempt.
    fake.reset();
    const sockets: WebSocket[] = [];
    for (let i = 0; i < 6; i++) sockets.push(await open());
    await vi.waitFor(() => expect(attaches()).toHaveLength(6));

    expect(await closedWith(SESSION)).toBe(4429);
    expect(attaches()).toHaveLength(6);

    const clients = attaches();
    for (const socket of sockets) socket.close();
    await vi.waitFor(() => expect(clients.every((c) => gone(c.pid))).toBe(true), {
      timeout: 10_000,
    });
  });
});
