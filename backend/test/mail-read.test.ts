import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading one message (A-25), against a mocked imapflow.
 *
 * What is pinned is what crosses the wire: a message with an attachment is
 * read by fetching its text part and nothing else, and the ways that can come
 * up short all end in the old full fetch rather than in an empty answer.
 */
type Query = { source?: boolean; bodyStructure?: boolean };
const fetched: Query[] = [];
const downloaded: { part: string; maxBytes?: number }[] = [];
let structure: unknown;
let partText = "";

const SOURCE = [
  "From: Kari <kari@example.com>",
  "To: Morten <morten@example.com>",
  "Subject: One part",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Just the one part, går det bra?",
  "",
].join("\r\n");

vi.mock("imapflow", async () => {
  // An EventEmitter, as the real one is: the kept connection listens for close.
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      async connect() {}
      async logout() {}
      async getMailboxLock() {
        return { release() {} };
      }
      async fetchOne(_uid: string, query: Query) {
        fetched.push(query);
        return {
          uid: 4,
          flags: new Set<string>(),
          envelope: {
            subject: "The scan",
            from: [{ name: "Kari", address: "kari@example.com" }],
            to: [
              { name: "Morten", address: "morten@example.com" },
              { address: "post@example.com" },
            ],
          },
          ...(query.bodyStructure ? { bodyStructure: structure } : {}),
          ...(query.source ? { source: Buffer.from(SOURCE) } : {}),
        };
      }
      async download(_uid: string, part: string, opts: { maxBytes?: number }) {
        downloaded.push({ part, maxBytes: opts.maxBytes });
        return { meta: {}, content: Readable.from([Buffer.from(partText)]) };
      }
    },
  };
});

const WITH_SCAN = {
  type: "multipart/mixed",
  childNodes: [
    {
      type: "multipart/alternative",
      part: "1",
      childNodes: [
        { type: "text/plain", part: "1.1" },
        { type: "text/html", part: "1.2" },
      ],
    },
    {
      type: "application/pdf",
      part: "2",
      disposition: "attachment",
      dispositionParameters: { filename: "scan.pdf" },
    },
    // Named by its content type alone, which is how some phones send a photo.
    { type: "image/jpeg", part: "3", parameters: { name: "IMG_0042.jpg" } },
  ],
};

let mail: typeof import("../src/mail.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailread-"));
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  fs.writeFileSync(
    process.env.SETTINGS_FILE,
    JSON.stringify({
      vars: { IMAP_HOST: "imap.example.com", IMAP_USER: "someone@example.com", IMAP_PASSWORD: "x" },
    }),
  );
  process.env.ASSISTANT_DIR = path.join(dir, "assistant");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailread-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mailread-s-"));
  mail = await import("../src/mail.js");
});

beforeEach(() => {
  fetched.length = 0;
  downloaded.length = 0;
  structure = WITH_SCAN;
  partText = "See the scan attached.";
});

describe("reading a message with attachments", () => {
  it("downloads the text part, capped, and never the message", async () => {
    const msg = await mail.read(4);

    expect(msg).toMatchObject({
      subject: "The scan",
      text: "See the scan attached.",
      to: "Morten <morten@example.com>, post@example.com",
      attachments: ["scan.pdf", "IMG_0042.jpg"],
    });
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0].part).toBe("1.1");
    expect(downloaded[0].maxBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(fetched.some((q) => q.source)).toBe(false);
  });

  it("reduces the HTML part when that is all the text there is", async () => {
    structure = {
      type: "multipart/mixed",
      childNodes: [
        { type: "text/html", part: "1" },
        { type: "application/pdf", part: "2", disposition: "attachment" },
      ],
    };
    partText = "<p>Hei <b>Morten</b></p>";

    const msg = await mail.read(4);

    expect(msg?.text).toBe("Hei Morten");
    expect(msg?.attachments).toEqual(["(unnamed)"]);
    expect(downloaded[0].part).toBe("1");
  });

  it("does not take a text file that was attached for the message", async () => {
    structure = {
      type: "multipart/mixed",
      childNodes: [
        {
          type: "text/plain",
          part: "1",
          disposition: "attachment",
          dispositionParameters: { filename: "log.txt" },
        },
        { type: "text/plain", part: "2" },
      ],
    };
    await mail.read(4);
    expect(downloaded[0].part).toBe("2");
  });

  it("cuts a long body where it always has", async () => {
    partText = "x".repeat(mail.BODY_BYTES + 500);
    const msg = await mail.read(4);
    expect(msg?.text.endsWith(`[cut at ${mail.BODY_BYTES} bytes]`)).toBe(true);
  });
});

describe("the ways that can come up short", () => {
  it("reads a one-part message whole, which is all there is of it", async () => {
    structure = { type: "text/plain" };

    const msg = await mail.read(4);

    expect(msg?.text).toBe("Just the one part, går det bra?");
    expect(downloaded).toEqual([]);
    expect(fetched.at(-1)?.source).toBe(true);
  });

  it("falls back to the whole message when the text part turns out empty", async () => {
    partText = "   ";
    const msg = await mail.read(4);
    expect(msg?.text).toBe("Just the one part, går det bra?");
  });

  it("falls back when the structure has no text part it can name", async () => {
    structure = { type: "multipart/mixed", childNodes: [{ type: "application/pdf", part: "1" }] };
    const msg = await mail.read(4);
    expect(msg?.text).toBe("Just the one part, går det bra?");
    expect(downloaded).toEqual([]);
  });
});
