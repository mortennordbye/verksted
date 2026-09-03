import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Filing mail, short of a live server.
 *
 * The property worth a test is not that IMAP moves a message, which is the
 * library's job, but that a folder name a model invented never reaches the
 * server: the destination is matched against what LIST returned, so a wrong
 * one is a sentence back rather than a mailbox created on the way past. The
 * fake below is the smallest thing that answers LIST and records MOVE.
 */
const moves: { uids: unknown; to: string }[] = [];

/** Gmail's own shape: a `[Gmail]` container that cannot hold mail, and paths
 *  under it whose names are the account's language, not English. */
const BOXES = [
  { path: "INBOX", name: "INBOX", flags: new Set<string>(), specialUse: "\\Inbox" },
  { path: "[Gmail]", name: "[Gmail]", flags: new Set(["\\Noselect"]), specialUse: undefined },
  { path: "[Gmail]/Spam", name: "Spam", flags: new Set<string>(), specialUse: "\\Junk" },
  { path: "[Gmail]/All Mail", name: "All Mail", flags: new Set<string>(), specialUse: "\\All" },
];

vi.mock("imapflow", () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async getMailboxLock() {
      return { release() {} };
    }
    async list() {
      return BOXES;
    }
    async messageMove(uids: unknown, to: string) {
      moves.push({ uids, to });
      return { uidMap: new Map([[1, 11]]) };
    }
  },
}));

let mail: typeof import("../src/mail.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mail-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: { IMAP_HOST: "imap.gmail.com", IMAP_USER: "someone@example.com", IMAP_PASSWORD: "x" },
    }),
  );
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mail-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mail-s-"));
  mail = await import("../src/mail.js");
});

describe("filing mail", () => {
  it("lists what a message can be moved into, and not the container", async () => {
    const folders = await mail.folders();
    expect(folders.map((f) => f.path)).toEqual(["INBOX", "[Gmail]/Spam", "[Gmail]/All Mail"]);
    // The role is what a model matches on, because the name is translated.
    expect(folders.find((f) => f.role === "junk")?.path).toBe("[Gmail]/Spam");
  });

  it("refuses a folder the server did not list", async () => {
    await expect(mail.move([1], "Junk")).rejects.toBeInstanceOf(mail.MailDenied);
    await expect(mail.move([1], "[Gmail]")).rejects.toBeInstanceOf(mail.MailDenied);
    await expect(mail.move([1], "INBOX")).rejects.toBeInstanceOf(mail.MailDenied);
    expect(moves).toEqual([]);
  });

  it("moves by uid, deduped and capped, and reports what the server confirmed", async () => {
    const moved = await mail.move([3, 3, 2], "[Gmail]/Spam");
    expect(moves).toEqual([{ uids: [3, 2], to: "[Gmail]/Spam" }]);
    // One entry in the uidMap: the other uid was gone before the move landed.
    expect(moved).toBe(1);

    moves.length = 0;
    await mail.move(
      Array.from({ length: mail.MAX_MOVE + 10 }, (_, i) => i + 1),
      "[Gmail]/All Mail",
    );
    expect((moves[0].uids as number[]).length).toBe(mail.MAX_MOVE);
  });
});
