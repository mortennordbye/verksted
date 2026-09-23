import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The kept IMAP connection (backlog: every mail call opened its own). What is
 * pinned is when a new one is opened: not for a second call, again when the
 * last one broke, again for new credentials, and never twice for a write.
 */
const opened: { user: string }[] = [];
/** What the next `list` does: answer, or break the connection under it. */
let listing: "ok" | "break" = "ok";
let moving: "ok" | "break" = "ok";
let moves = 0;

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      usable = true;
      constructor(readonly options: { auth: { user: string } }) {
        super();
      }
      async connect() {
        opened.push({ user: this.options.auth.user });
      }
      async logout() {
        this.usable = false;
      }
      async getMailboxLock() {
        return { release() {} };
      }
      async list() {
        if (listing === "break") {
          listing = "ok";
          this.usable = false;
          throw Object.assign(new Error("Connection closed"), { code: "NoConnection" });
        }
        return [
          { path: "INBOX", name: "INBOX", flags: new Set(), specialUse: "\\Inbox" },
          { path: "Archive", name: "Archive", flags: new Set() },
        ];
      }
      async messageMove() {
        moves++;
        if (moving === "break") {
          this.usable = false;
          throw Object.assign(new Error("Connection closed"), { code: "ECONNRESET" });
        }
        return false;
      }
    },
  };
});

let mail: typeof import("../src/mail.js");
let settingsFile: string;

const setUser = (user: string) =>
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      vars: { IMAP_HOST: "imap.example.com", IMAP_USER: user, IMAP_PASSWORD: "x" },
    }),
  );

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailconn-"));
  settingsFile = path.join(dir, "settings.json");
  process.env.SETTINGS_FILE = settingsFile;
  setUser("a@example.com");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailconn-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailconn-s-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailconn-a-"));
  mail = await import("../src/mail.js");
});

beforeEach(() => {
  listing = "ok";
  moving = "ok";
  moves = 0;
});

describe("the kept IMAP connection", () => {
  it("logs in once for calls that follow each other", async () => {
    const before = opened.length;
    await mail.folders();
    await mail.folders();
    await Promise.all([mail.folders(), mail.folders()]);
    expect(opened.length - before).toBeLessThanOrEqual(1);
  });

  it("asks a read again on a new connection when the old one broke", async () => {
    await mail.folders();
    const before = opened.length;
    listing = "break";
    const folders = await mail.folders();
    expect(folders.map((f) => f.path)).toEqual(["INBOX", "Archive"]);
    expect(opened.length - before).toBe(1);
  });

  it("does not ask a move again, since the first may have happened", async () => {
    moving = "break";
    await expect(mail.move([1], "Archive")).rejects.toThrow("Connection closed");
    expect(moves).toBe(1);
  });

  it("logs in again when the credentials change", async () => {
    await mail.folders();
    const before = opened.length;
    setUser("b@example.com");
    await mail.folders();
    expect(opened.slice(before)).toEqual([{ user: "b@example.com" }]);
  });
});
