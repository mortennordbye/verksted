import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The feed and the loops: stores, pollers and routes, without a model.
 *
 * What is pinned is the version rule (the same event is one item, a moved-on
 * event is new again whatever state it was in), that a poller's "over" resolves
 * rather than deletes, that the bench is polled on every read, the loop
 * ordering, the retention sweep, and the shape of what a briefing is handed.
 */
let app: FastifyInstance;
let feedDir: string;
let feed: typeof import("../src/feed-store.js");
let loops: typeof import("../src/loops-store.js");
let pollers: typeof import("../src/pollers.js");
let scheduler: typeof import("../src/scheduler.js");

beforeAll(async () => {
  feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-feed-"));
  process.env.FEED_DIR = feedDir;
  process.env.LOOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-loops-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
  loops = await import("../src/loops-store.js");
  pollers = await import("../src/pollers.js");
  scheduler = await import("../src/scheduler.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  for (const dir of [feedDir, process.env.LOOPS_DIR!]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  }
});

const seen = (id: string, version = "1", at = "2026-08-30T07:00:00.000Z") => ({
  id,
  source: "github" as const,
  at,
  title: `title of ${id}`,
  detail: "a detail",
  link: "https://github.com/x/y/pull/1",
  version,
});

describe("the feed store", () => {
  it("files an event once, and again only when it moves on", async () => {
    const first = await feed.upsert(seen("github:1"));
    expect(first.changed).toBe(true);
    expect(first.item.state).toBe("new");
    expect(first.item.triaged).toBe(false);

    await feed.setState("github:1", "done");
    // Same version: nothing changes, the done stays done.
    expect((await feed.upsert(seen("github:1"))).changed).toBe(false);
    expect((await feed.get("github:1"))!.state).toBe("done");

    // A new version: the thread got a reply, and it is new again.
    const moved = await feed.upsert(seen("github:1", "2"));
    expect(moved.changed).toBe(true);
    expect(moved.item.state).toBe("new");
    expect(moved.item.triaged).toBe(false);
    // First seen is kept: the row does not jump to the top of the feed.
    expect(moved.item.at).toBe("2026-08-30T07:00:00.000Z");
  });

  it("lifts a snooze that is over, and keeps one that is not", async () => {
    await feed.upsert(seen("github:2"));
    await feed.upsert(seen("github:3"));
    await feed.setState("github:2", "snoozed", "2020-01-01T00:00:00.000Z");
    await feed.setState("github:3", "snoozed", "2099-01-01T00:00:00.000Z");
    const items = await feed.list();
    expect(items.find((i) => i.id === "github:2")!.state).toBe("new");
    expect(items.find((i) => i.id === "github:3")!.state).toBe("snoozed");
  });

  it("resolves what is over rather than deleting it, and sweeps done after thirty days", async () => {
    await feed.upsert(seen("bench:wait:vk-x-1", "waiting", "2026-07-01T00:00:00.000Z"));
    await feed.resolve("bench:wait:vk-x-1", "answered");
    const item = (await feed.get("bench:wait:vk-x-1"))!;
    expect(item.state).toBe("done");
    expect(item.did).toBe("answered");
    expect(await feed.sweep(Date.parse("2026-07-15T00:00:00.000Z"))).toBe(0);
    expect(await feed.sweep(Date.parse("2026-08-15T00:00:00.000Z"))).toBe(1);
    expect(await feed.get("bench:wait:vk-x-1")).toBeNull();
  });
});

describe("the loops", () => {
  it("orders due first, then by age, and closes by slug", async () => {
    const later = await loops.open({ what: "renew the domain", due: "2026-09-03" });
    const undated = await loops.open({ what: "call the dentist" });
    const soon = await loops.open({ what: "form back to barnehagen", due: "2026-09-01" });
    expect((await loops.list()).map((l) => l.slug)).toEqual([soon.slug, later.slug, undated.slug]);
    expect(soon.slug).toBe("form-back-to-barnehagen");

    // The same words again is a new loop, not the old one reopened.
    const again = await loops.open({ what: "call the dentist" });
    expect(again.slug).toBe("call-the-dentist-2");

    await loops.close(undated.slug);
    expect((await loops.list()).map((l) => l.slug)).not.toContain(undated.slug);
    expect((await loops.list("all")).find((l) => l.slug === undated.slug)!.state).toBe("closed");
  });

  it("refuses a due date that is not a date", async () => {
    await expect(loops.open({ what: "x", due: "next week" })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe("the pollers", () => {
  it("turns the bench's lists into items, and ends them when they end", () => {
    const waiting = {
      id: "vk-demo-1",
      project: "demo",
      title: "tidy",
      status: "waiting",
      report: null,
    } as never;
    const done = { ...(waiting as object), id: "vk-demo-2", status: "done" } as never;
    const { seen: items, over } = pollers.sessionItems([waiting, done]);
    expect(items.map((i) => [i.id, i.urgency])).toEqual([["bench:wait:vk-demo-1", "attention"]]);
    expect(over).toEqual(["bench:wait:vk-demo-2"]);
  });

  it("reads a notification into a page a person can open", () => {
    const [pr] = pollers.notificationItems([
      {
        id: "77",
        reason: "review_requested",
        updated_at: "2026-08-30T08:00:00Z",
        subject: {
          title: "Bump node",
          type: "PullRequest",
          url: "https://api.github.com/repos/mortennordbye/verksted/pulls/97",
        },
        repository: {
          full_name: "mortennordbye/verksted",
          html_url: "https://github.com/mortennordbye/verksted",
        },
      },
    ]);
    expect(pr.id).toBe("github:77");
    expect(pr.link).toBe("https://github.com/mortennordbye/verksted/pull/97");
    expect(pr.detail).toBe("PullRequest, your review was asked for");
    expect(pr.version).toBe("2026-08-30T08:00:00Z");
  });

  it("polls the bench on every read of the feed, so the feed is never behind", async () => {
    // A proposal on the volume becomes an item; keeping it ends the item.
    await app.inject({
      method: "POST",
      url: "/api/memory/proposed",
      payload: { slug: "likes-tabs", text: "Prefers tabs.", type: "preference" },
    });
    let items = (await app.inject({ url: "/api/feed" })).json();
    expect(items.map((i: { id: string }) => i.id)).toContain("memory:likes-tabs");

    await app.inject({ method: "DELETE", url: "/api/memory/proposed/likes-tabs" });
    items = (await app.inject({ url: "/api/feed" })).json();
    const gone = items.find((i: { id: string }) => i.id === "memory:likes-tabs");
    expect(gone.state).toBe("done");
    expect(gone.did).toBe("reviewed");
  });
});

describe("triage verdicts", () => {
  it("are read off tab-separated lines, and a bad line is skipped", () => {
    const text = [
      "github:1\tattention\tReview asked for on #97; two files.\t-",
      "github:2\tquiet\tRenovate bumped a patch.\tnew: reply to Kari | 2026-09-02",
      "github:3\tnew\tCI on your branch.\trenew-the-domain",
      "not a verdict at all",
      "github:4\tloud\tno such urgency\t-",
    ].join("\n");
    expect(scheduler.parseVerdicts(text)).toEqual([
      {
        id: "github:1",
        urgency: "attention",
        summary: "Review asked for on #97; two files.",
        loop: null,
      },
      {
        id: "github:2",
        urgency: "quiet",
        summary: "Renovate bumped a patch.",
        loop: { open: "reply to Kari", due: "2026-09-02" },
      },
      {
        id: "github:3",
        urgency: "new",
        summary: "CI on your branch.",
        loop: { slug: "renew-the-domain" },
      },
    ]);
  });
});

describe("the feed routes", () => {
  it("sets state from the screen, and needs an until to snooze", async () => {
    await feed.upsert(seen("github:9"));
    const bad = await app.inject({
      method: "POST",
      url: "/api/feed/github:9/state",
      payload: { state: "snoozed" },
    });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "POST",
      url: "/api/feed/github:9/state",
      payload: { state: "snoozed", until: "2099-01-01T07:00:00.000Z" },
    });
    expect(ok.json().state).toBe("snoozed");
    const missing = await app.inject({
      method: "POST",
      url: "/api/feed/github:nope/state",
      payload: { state: "done" },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("hands a briefing the feed, the loops and the bench in one text", async () => {
    await feed.upsert(seen("github:5"));
    await feed.judge("github:5", { urgency: "attention", detail: "Review #97 today." });
    await feed.upsert({ ...seen("schedule:s:1"), source: "schedule", urgency: "quiet" });
    await loops.open({ what: "renew the domain", due: "2026-09-03" });

    const { text } = (await app.inject({ url: "/api/feed/material" })).json();
    expect(text).toContain("- [attention] github: title of github:5. Review #97 today.");
    expect(text).toContain("1 quiet thing(s): 1 schedule");
    expect(text).toContain("- renew-the-domain: renew the domain, due 2026-09-03");
    expect(text).toContain("nothing running");
  });
});
