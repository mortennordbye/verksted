import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * GET /api/feed/:id/facts: what an opened row fetches from its source.
 *
 * gh is a fake on PATH, so the argv it is given is the argv asserted; IMAP is a
 * mocked imapflow, as in mail-read.test.ts. What is pinned is what each source
 * answers, that the answer is kept rather than fetched again, and that a source
 * which cannot be read is nulls and a 200, never a 500.
 */
let app: FastifyInstance;
let fake: FakeBin;
let sessionsDir: string;
let feed: typeof import("../src/feed-store.js");
let facts: typeof import("../src/feed-facts.js");

const downloaded: { part: string; maxBytes?: number }[] = [];
let structure: unknown;
let partText = "";

vi.mock("imapflow", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ImapFlow: class extends EventEmitter {
      async connect() {}
      async logout() {}
      async getMailboxLock() {
        return { release() {} };
      }
      async fetchOne(_uid: string, query: { source?: boolean }) {
        if (query.source) throw new Error("the whole message was fetched");
        return { uid: 9, bodyStructure: structure };
      }
      async download(_uid: string, part: string, opts: { maxBytes?: number }) {
        downloaded.push({ part, maxBytes: opts.maxBytes });
        return { meta: {}, content: Readable.from([Buffer.from(partText)]) };
      }
    },
  };
});

beforeAll(async () => {
  fake = FakeBin.install(["gh", "tmux"]);
  fake.reply("tmux", "ls", { stdout: "" });
  process.env.FEED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-feed-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-sess-"));
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.STATIC_DIR = "";
  const settings = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-facts-set-")), "s.json");
  fs.writeFileSync(
    settings,
    JSON.stringify({
      vars: { IMAP_HOST: "imap.example.com", IMAP_USER: "someone@example.com", IMAP_PASSWORD: "x" },
    }),
  );
  process.env.SETTINGS_FILE = settings;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
  facts = await import("../src/feed-facts.js");
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
  fake.clear("gh");
  facts.resetFeedFacts();
  downloaded.length = 0;
  structure = { type: "text/plain" };
  partText = "";
});

const file = (id: string, source: "github" | "mail" | "bench" | "schedule", link: string | null) =>
  feed.upsert({
    id,
    source,
    at: "2026-09-20T07:00:00.000Z",
    title: `title of ${id}`,
    detail: "",
    link,
    version: "1",
  });

const factsOf = (id: string) => app.inject({ url: `/api/feed/${encodeURIComponent(id)}/facts` });

describe("a pull request", () => {
  it("asks gh for its checks and size, by the repo and number its link names", async () => {
    await file("github:1", "github", "https://github.com/o/r/pull/602");
    fake.reply("gh", "pr view", {
      stdout: JSON.stringify({
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        additions: 248,
        deletions: 31,
        changedFiles: 5,
      }),
    });

    const res = await factsOf("github:1");

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      checks: "passing",
      diff: { additions: 248, deletions: 31, files: 5 },
      firstLine: null,
      durationMs: null,
      tokens: null,
    });
    expect(fake.argvFor("gh")).toEqual([
      [
        "pr",
        "view",
        "602",
        "--repo=o/r",
        "--json",
        "statusCheckRollup,additions,deletions,changedFiles",
      ],
    ]);
  });

  it("is fetched once, and the second open is the kept answer", async () => {
    await file("github:2", "github", "https://github.com/o/r/pull/7");
    fake.reply("gh", "pr view", {
      stdout: JSON.stringify({
        statusCheckRollup: [],
        additions: 1,
        deletions: 0,
        changedFiles: 1,
      }),
    });

    await factsOf("github:2");
    const again = await factsOf("github:2");

    expect(again.json().checks).toBe("none");
    expect(fake.argvFor("gh")).toHaveLength(1);
  });

  it("is nulls rather than a 500 when gh cannot be read, and is asked again next time", async () => {
    await file("github:3", "github", "https://github.com/o/r/pull/8");
    fake.reply("gh", "pr view", { code: 1, stderr: "HTTP 401: Bad credentials" });

    const res = await factsOf("github:3");
    await factsOf("github:3");

    expect(res.statusCode).toBe(200);
    expect(res.json().checks).toBeNull();
    expect(fake.argvFor("gh")).toHaveLength(2);
  });

  it("does not call gh for an issue, which has no checks", async () => {
    await file("github:4", "github", "https://github.com/o/r/issues/9");
    const res = await factsOf("github:4");
    expect(res.json().diff).toBeNull();
    expect(fake.argvFor("gh")).toEqual([]);
  });
});

describe("a mail", () => {
  it("is the first line of the text part, capped, and never the whole message", async () => {
    await file("mail:9", "mail", null);
    structure = {
      type: "multipart/mixed",
      childNodes: [
        { type: "text/plain", part: "1" },
        { type: "application/pdf", part: "2", disposition: "attachment" },
      ],
    };
    partText = "\n\n  A new sign-in on Mac OS, from Norway  \nSecond line.";

    const res = await factsOf("mail:9");

    expect(res.json().firstLine).toBe("A new sign-in on Mac OS, from Norway");
    expect(downloaded).toEqual([{ part: "1", maxBytes: 32 * 1024 }]);
  });

  it("reads a one-part message as its part 1, and an HTML one as its text", async () => {
    await file("mail:10", "mail", null);
    structure = { type: "text/html" };
    partText = "<style>p{}</style><p>Your flight to Oslo departs in 34 hours</p><p>More</p>";

    const res = await factsOf("mail:10");

    expect(res.json().firstLine).toBe("Your flight to Oslo departs in 34 hours");
    expect(downloaded[0]?.part).toBe("1");
  });

  it("has no line when there is no text part to name", async () => {
    await file("mail:11", "mail", null);
    structure = { type: "application/pdf", disposition: "attachment" };
    const res = await factsOf("mail:11");
    expect(res.statusCode).toBe(200);
    expect(res.json().firstLine).toBeNull();
    expect(downloaded).toEqual([]);
  });
});

describe("a run", () => {
  it("is the duration and the tokens of the session its link opens", async () => {
    fs.writeFileSync(
      path.join(sessionsDir, "vk-demo-3.json"),
      JSON.stringify({
        id: "vk-demo-3",
        project: "demo",
        agent: "claude",
        title: "morning briefing",
        createdAt: "2026-09-20T07:00:00.000Z",
        endedAt: "2026-09-20T07:04:12.000Z",
        usage: { input: 1000, output: 2000, cacheRead: 30000, cacheWrite: 5000, turns: 4 },
      }),
    );
    await file("schedule:sch-00000001:2026-09-20T07:00:00.000Z", "schedule", "/s/vk-demo-3");

    const res = await factsOf("schedule:sch-00000001:2026-09-20T07:00:00.000Z");

    expect(res.json()).toMatchObject({ durationMs: 252_000, tokens: 38_000 });
  });

  it("is nulls for a session that is gone", async () => {
    await file("bench:wait:vk-demo-99", "bench", "/s/vk-demo-99");
    const res = await factsOf("bench:wait:vk-demo-99");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ durationMs: null, tokens: null });
  });
});

describe("the id", () => {
  it("is a 404 for an item that is not on the feed", async () => {
    expect((await factsOf("github:nope")).statusCode).toBe(404);
  });

  it("is refused past the length every feed route allows", async () => {
    // Fastify's own parameter cap answers first (414); the schema is the backstop.
    const res = await factsOf(`github:${"x".repeat(400)}`);
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });
});
