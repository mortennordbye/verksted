import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import type { BrowserServerMsg } from "../../shared/api.js";
import { FakeBin, tmuxLsRows } from "./helpers/fake-bin.js";

/**
 * The session browser's two routes: the start an agent's MCP wrapper curls,
 * and the socket the pane streams over. Chromium itself is stubbed; what is
 * under test is what these routes decide before and around it — which session
 * gets a browser, on which port, and what a pane's messages turn into.
 */

const fakeBrowser = vi.hoisted(() => ({
  launches: [] as { id: string; port: number }[],
  fail: false,
  listeners: new Set<(msg: BrowserServerMsg) => void>(),
  gotos: [] as string[],
  keys: [] as Record<string, unknown>[],
}));

vi.mock("../src/browser.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/browser.js")>();
  const entry = {
    current: {
      goto: (url: string) => {
        fakeBrowser.gotos.push(url);
        return Promise.resolve(null);
      },
    },
    cdp: {
      send: (_method: string, params: Record<string, unknown>) => {
        fakeBrowser.keys.push(params);
        return Promise.resolve({});
      },
    },
  };
  return {
    ...real,
    ensureBrowser: (id: string, port: number) => {
      if (fakeBrowser.fail) return Promise.reject(new Error("chromium would not start"));
      fakeBrowser.launches.push({ id, port });
      return Promise.resolve(entry);
    },
    addListener: (_e: unknown, fn: (msg: BrowserServerMsg) => void) => {
      fakeBrowser.listeners.add(fn);
      return Promise.resolve();
    },
    removeListener: (_e: unknown, fn: (msg: BrowserServerMsg) => void) => {
      fakeBrowser.listeners.delete(fn);
      return Promise.resolve();
    },
  };
});

const LIVE = "vk-demo-1";
const GONE = "vk-demo-2";
let app: FastifyInstance;
let port: number;
let fake: FakeBin;

function open(id: string): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/api/sessions/${id}/browser`);
}

function closedWith(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.addEventListener("close", (ev) => resolve(ev.code)));
}

beforeAll(async () => {
  fake = FakeBin.install(["tmux"]);
  // Only LIVE has a tmux session; GONE has metadata and nothing running.
  fake.reply("tmux", "ls", { stdout: tmuxLsRows(LIVE) });
  const sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-browser-ws-"));
  for (const id of [LIVE, GONE]) {
    fs.writeFileSync(
      path.join(sessionsDir, `${id}.json`),
      JSON.stringify({
        id,
        project: "demo",
        agent: "claude",
        title: "a session with a browser",
        createdAt: new Date().toISOString(),
        ...(id === GONE ? { endedAt: new Date().toISOString() } : {}),
      }),
    );
  }
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

beforeEach(() => {
  fakeBrowser.launches.length = 0;
  fakeBrowser.gotos.length = 0;
  fakeBrowser.keys.length = 0;
  fakeBrowser.fail = false;
});

describe("starting a session's browser", () => {
  it("launches one for a live session, on a port the session keeps", async () => {
    const first = await app.inject({ method: "POST", url: `/api/sessions/${LIVE}/browser/start` });
    const again = await app.inject({ method: "POST", url: `/api/sessions/${LIVE}/browser/start` });

    expect(first.statusCode).toBe(200);
    const [a, b] = fakeBrowser.launches;
    expect(a?.id).toBe(LIVE);
    expect(first.json()).toEqual({ cdpUrl: `http://127.0.0.1:${a?.port}` });
    expect(b?.port).toBe(a?.port);
    expect(again.json()).toEqual(first.json());
  });

  it("refuses an unknown or ended session without launching anything", async () => {
    for (const id of ["vk-demo-9", GONE]) {
      const res = await app.inject({ method: "POST", url: `/api/sessions/${id}/browser/start` });
      expect(res.statusCode).toBe(404);
    }
    expect(fakeBrowser.launches).toEqual([]);
  });

  it("answers 502 when chromium will not start", async () => {
    fakeBrowser.fail = true;
    const res = await app.inject({ method: "POST", url: `/api/sessions/${LIVE}/browser/start` });
    expect(res.statusCode).toBe(502);
  });
});

describe("the browser pane's socket", () => {
  it("closes on a session that is not running", async () => {
    expect(await closedWith(open("vk-demo-9"))).toBe(4404);
    expect(await closedWith(open(GONE))).toBe(4404);
  });

  it("closes with 4502 when chromium will not start", async () => {
    fakeBrowser.fail = true;
    expect(await closedWith(open(LIVE))).toBe(4502);
  });

  it("streams to the pane, drives the page, and lets go of its listener on close", async () => {
    const socket = open(LIVE);
    const got: BrowserServerMsg[] = [];
    socket.addEventListener("message", (ev) => got.push(JSON.parse(String(ev.data))));
    await vi.waitFor(() => expect(fakeBrowser.listeners.size).toBe(1));

    // What the browser says reaches the pane.
    for (const fn of fakeBrowser.listeners) fn({ t: "url", url: "https://example.com/" });
    await vi.waitFor(() => expect(got).toContainEqual({ t: "url", url: "https://example.com/" }));

    // A schemeless address is taken as http, and a script URL is refused.
    socket.send(JSON.stringify({ t: "nav", url: "localhost:3000/x" }));
    socket.send(JSON.stringify({ t: "nav", url: "javascript:alert(1)" }));
    await vi.waitFor(() => expect(fakeBrowser.gotos).toEqual(["http://localhost:3000/x"]));
    await vi.waitFor(() => expect(got).toContainEqual({ t: "error", message: "invalid url" }));

    // Keys are clamped before they reach CDP.
    socket.send(
      JSON.stringify({ t: "key", type: "keyDown", key: "a".repeat(100), keyCode: 9999, text: "a" }),
    );
    await vi.waitFor(() => expect(fakeBrowser.keys).toHaveLength(1));
    expect(fakeBrowser.keys[0]).toMatchObject({ type: "keyDown", windowsVirtualKeyCode: 255 });
    expect(String(fakeBrowser.keys[0]?.key)).toHaveLength(32);

    socket.close();
    await vi.waitFor(() => expect(fakeBrowser.listeners.size).toBe(0));
  });
});
