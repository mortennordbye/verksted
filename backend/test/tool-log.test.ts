import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * A-31. The tool log: every call that changed something, with its arguments.
 *
 * The thread keeps a tool's name and eighty characters of one argument, which
 * cannot answer "what did it move last night" and cannot be undone from. What
 * is pinned here is that a call that changes something is written in full,
 * that a read is not written at all, and that the line lands in the day's file
 * whole however long the arguments were.
 */
let assistantDir: string;
let app: FastifyInstance;
let toolLog: typeof import("../src/tool-log.js");
let journal: typeof import("../src/journal-store.js");

const CALL = {
  turn: "turn-1",
  speaker: "chair",
  unattended: false,
  tool: "mail_move",
  effect: "reversible",
  args: { uids: [4, 5], to: "Arkiv" },
  ok: true,
  result: "moved 2 to Arkiv",
};

/** Today's lines, as they were written. */
function lines(): Record<string, unknown>[] {
  const file = path.join(toolLog.toolLogDir(), `${journal.today()}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

beforeAll(async () => {
  assistantDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-toollog-"));
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.SETTINGS_FILE = path.join(assistantDir, "settings.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  toolLog = await import("../src/tool-log.js");
  journal = await import("../src/journal-store.js");
});

afterAll(async () => {
  await app.close();
  fs.rmSync(assistantDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(assistantDir, "tool-log"), { recursive: true, force: true });
});

describe("the tool log", () => {
  it("keeps a call in full, with who made it and what came back", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/turn/tool",
      payload: CALL,
    });

    expect(res.statusCode).toBe(200);
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({
      turn: "turn-1",
      speaker: "chair",
      unattended: false,
      tool: "mail_move",
      effect: "reversible",
      // In full: the chip in the thread says "mail_move" and stops there, and
      // which messages went where is the whole of what an undo would need.
      args: { uids: [4, 5], to: "Arkiv" },
      ok: true,
      result: "moved 2 to Arkiv",
    });
    expect(typeof lines()[0].at).toBe("string");
  });

  it("appends rather than replacing, so two advisors at once both land", async () => {
    await toolLog.record({ ...CALL, speaker: "uriel" });
    await toolLog.record({ ...CALL, speaker: "gabriel", tool: "calendar_add" });

    expect(lines().map((l) => l.speaker)).toEqual(["uriel", "gabriel"]);
  });

  it("writes one line however long the arguments were", async () => {
    // A prompt or a mail body would otherwise put a megabyte on one line. The
    // record still says a call was made, which is worth more than no record.
    await toolLog.record({ ...CALL, args: { prompt: "x".repeat(40_000) } });

    const [line] = lines();
    expect(JSON.stringify(line).length).toBeLessThan(20_000);
    expect(line.tool).toBe("mail_move");
    expect(line.args).toEqual({ dropped: expect.stringContaining("bytes") });
  });

  it("keeps the evidence of a reply, not the reply", async () => {
    await toolLog.record({ ...CALL, ok: false, result: "y".repeat(4000) });

    expect(String(lines()[0].result)).toHaveLength(500);
    expect(lines()[0].ok).toBe(false);
  });

  it("refuses a record that does not say whose turn it was", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/assistant/turn/tool",
      payload: { ...CALL, turn: undefined },
    });

    expect(res.statusCode).toBe(400);
    expect(lines()).toEqual([]);
  });
});
