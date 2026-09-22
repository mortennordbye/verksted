import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Stopping a turn ends what the turn started (A-15).
 *
 * The real CLI is a parent: it starts the MCP servers, and for the chair a
 * browser wrapper. FakeBin's `claude` is one process, which is exactly the
 * shape that cannot show the fault, so this file puts its own on PATH: a shell
 * that starts a child, says where it is, and waits.
 */
let dir: string;
let pidFile: string;
let oldPath: string | undefined;
let app: FastifyInstance;

/** Gone, or a zombie nobody has reaped: either way it holds nothing any more. */
function gone(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return true;
  }
}

async function until(check: () => boolean, ms = 4_000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-kill-"));
  pidFile = path.join(dir, "child.pid");
  fs.writeFileSync(
    path.join(dir, "claude"),
    `#!/bin/sh\nsleep 300 &\necho $! > ${pidFile}\nwait\n`,
    { mode: 0o755 },
  );
  oldPath = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${oldPath ?? ""}`;
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-kill-thread-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
  process.env.PATH = oldPath;
});

describe("stopping a turn", () => {
  it("ends the processes the CLI started, not only the CLI", async () => {
    const turn = app.inject({
      method: "POST",
      url: "/api/assistant/messages",
      payload: { text: "anything" },
    });
    expect(
      await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8") !== ""),
    ).toBe(true);
    const child = Number(fs.readFileSync(pidFile, "utf8"));
    expect(gone(child)).toBe(false);

    await app.inject({ method: "POST", url: "/api/assistant/stop" });
    await turn;

    expect(await until(() => gone(child))).toBe(true);
  });
});

describe("a turn that never comes back (A-32)", () => {
  it("is stopped at its limit, with what it started, and says so in the thread", async () => {
    fs.rmSync(pidFile, { force: true });
    const { setTurnTimeouts } = await import("../src/assistant-turn.js");
    const restore = setTurnTimeouts(300, 300);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/assistant/messages",
        payload: { text: "anything" },
      });

      // Nobody pressed stop: the limit ended it, and the request came back.
      const last = res.json().entries.at(-1);
      expect(last.failed).toBe(true);
      expect(last.text).toMatch(/ran past its time limit/);
      expect(res.json().status).toBe("idle");

      const child = Number(fs.readFileSync(pidFile, "utf8"));
      expect(await until(() => gone(child))).toBe(true);
    } finally {
      restore();
    }
  });
});
