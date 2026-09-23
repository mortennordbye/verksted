import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Putting back from the settings page's log (backlog: nothing the assistant
 * changed could be put back). What is pinned: a move goes back by the uids the
 * mail log has for where the messages landed, once, and a line with nothing on
 * record behind it undoes nothing.
 */
const moved: { uids: unknown; to: string; from: string | null }[] = [];
let selected: string | null = null;

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      async connect() {}
      async logout() {}
      async getMailboxLock(box: string) {
        selected = box;
        return { release() {} };
      }
      async list() {
        return [
          { path: "INBOX", name: "INBOX", flags: new Set(), specialUse: "\\Inbox" },
          { path: "Receipts", name: "Receipts", flags: new Set() },
        ];
      }
      async messageMove(uids: number[], to: string) {
        moved.push({ uids, to, from: selected });
        return { uidMap: new Map(uids.map((u) => [u, u + 100])) };
      }
    },
  };
});

let app: FastifyInstance;
let assistantDir: string;
const DAY = "2026-09-20";
const AT = "2026-09-20T10:00:05.000Z";

function writeLog(dir: string, lines: object[]) {
  fs.mkdirSync(path.join(assistantDir, dir), { recursive: true });
  fs.writeFileSync(
    path.join(assistantDir, dir, `${DAY}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

const call = (tool: string, args: object, at = AT) => ({
  at,
  turn: "t1",
  speaker: "Gabriel",
  unattended: false,
  tool,
  effect: "reversible",
  args,
  ok: true,
  result: "done",
});

const undo = (at = AT) =>
  app.inject({ method: "POST", url: "/api/assistant/tool-log/undo", payload: { day: DAY, at } });

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-undo-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: { IMAP_HOST: "imap.example.com", IMAP_USER: "a@example.com", IMAP_PASSWORD: "x" },
    }),
  );
  assistantDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-undo-a-"));
  process.env.ASSISTANT_DIR = assistantDir;
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-undo-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-undo-s-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  moved.length = 0;
  fs.rmSync(path.join(assistantDir, "tool-log"), { recursive: true, force: true });
  fs.rmSync(path.join(assistantDir, "mail-log"), { recursive: true, force: true });
});

describe("undo from the log", () => {
  it("moves mail back from where the server said it landed, once", async () => {
    writeLog("tool-log", [call("mail_move", { uids: [3, 4], to: "Receipts" })]);
    writeLog("mail-log", [
      {
        at: "2026-09-20T10:00:04.000Z",
        verb: "move",
        from: "INBOX",
        to: "Receipts",
        uids: [3, 4],
        uidMap: { "3": 53, "4": 54 },
      },
    ]);
    const before = (await app.inject({ url: `/api/assistant/tool-log?day=${DAY}` })).json();
    expect(before.entries[0].undo).toBe("can");

    const res = await undo();
    expect(res.statusCode).toBe(200);
    expect(res.json().said).toBe("2 messages moved back to INBOX");
    expect(moved).toEqual([{ uids: [53, 54], to: "INBOX", from: "Receipts" }]);

    const after = (await app.inject({ url: `/api/assistant/tool-log?day=${DAY}` })).json();
    expect(after.entries.find((e: { at: string }) => e.at === AT).undo).toBe("done");
    expect((await undo()).statusCode).toBe(409);
    expect(moved).toHaveLength(1);
  });

  it("says so when the server never said where the messages landed", async () => {
    writeLog("tool-log", [call("mail_move", { uids: [3], to: "Receipts" })]);
    writeLog("mail-log", [
      {
        at: "2026-09-20T10:00:04.000Z",
        verb: "move",
        from: "INBOX",
        to: "Receipts",
        uids: [3],
        uidMap: {},
      },
    ]);
    const res = await undo();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/did not say where/);
    expect(moved).toEqual([]);
  });

  it("takes only a log entry's time as the entry to put back", async () => {
    const res = await undo("__proto__");
    expect(res.statusCode).toBe(400);
  });

  it("undoes nothing that has no record behind it, or that is not undone from here", async () => {
    writeLog("tool-log", [
      call("mail_move", { uids: [9], to: "Receipts" }),
      call("calendar_add", { summary: "x" }, "2026-09-20T11:00:00.000Z"),
    ]);
    expect((await undo()).statusCode).toBe(409);
    expect((await undo("2026-09-20T11:00:00.000Z")).json().error).toMatch(/cannot be put back/);
    expect(moved).toEqual([]);
  });
});
