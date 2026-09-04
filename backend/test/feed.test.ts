import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { FeedItem } from "../../shared/api.js";
import { FakeBin } from "./helpers/fake-bin.js";

/**
 * The feed and the loops: stores, pollers and routes, without a model.
 *
 * What is pinned is the version rule (the same event is one item, a moved-on
 * event is new again whatever state it was in), that a poller's "over" resolves
 * rather than deletes, that the bench is polled on every read, the loop
 * ordering, the retention sweep, and the shape of what a briefing is handed.
 */
let app: FastifyInstance;
let fake: FakeBin;
const log = { info: () => {}, warn: () => {} };
let feedDir: string;
let settingsFile: string;
let feed: typeof import("../src/feed-store.js");
let loops: typeof import("../src/loops-store.js");
let pollers: typeof import("../src/pollers.js");
let scheduler: typeof import("../src/scheduler.js");

beforeAll(async () => {
  // Only gh: everything else on the path stays real, tmux included.
  fake = FakeBin.install(["gh"]);
  feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-feed-"));
  process.env.FEED_DIR = feedDir;
  process.env.LOOPS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-loops-"));
  process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
  process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.STATIC_DIR = "";
  settingsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vk-set-")), "settings.json");
  process.env.SETTINGS_FILE = settingsFile;
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
  loops = await import("../src/loops-store.js");
  pollers = await import("../src/pollers.js");
  scheduler = await import("../src/scheduler.js");
});

afterAll(async () => {
  await app.close();
  fake.uninstall();
});

beforeEach(() => {
  fake.reset();
  for (const dir of [feedDir, process.env.LOOPS_DIR!]) {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f));
  }
  fs.rmSync(settingsFile, { force: true });
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
    // On the facts line, and only there: the row draws the detail as well, so
    // saying it in both is the same words twice.
    expect(pr.facts).toEqual(["PullRequest", "your review was asked for"]);
    expect(pr.detail).toBe("");
    expect(pr.version).toBe("2026-08-30T08:00:00Z");
  });

  it("does not let a login that expired sit among the quiet ones", () => {
    const run = (schedule: string, outcome: string, error: string) => ({
      scheduleId: `sch-${schedule}`,
      schedule,
      at: "2026-09-02T05:00:00.000Z",
      outcome,
      error,
      report: null,
      sessionId: null,
    });
    const items = pollers.runItems([
      // The common blocked run: the schedule declining, several a night.
      run("build", "blocked", "queue empty") as never,
      // Not the schedule declining. Every schedule and every session is down,
      // and the turn that would report it is the one that died.
      run("morning briefing", "blocked", "Failed to authenticate: OAuth session expired") as never,
    ]);
    expect(items.map((i) => [i.title, i.urgency])).toEqual([
      ["build", "quiet"],
      ["morning briefing", "attention"],
    ]);
  });

  it("never files a notification from a blocked owner", () => {
    const thread = (repo: string) => ({
      id: repo,
      reason: "review_requested",
      updated_at: "2026-08-30T08:00:00Z",
      subject: { title: "a client's branch", type: "PullRequest", url: null },
      repository: { full_name: `${repo}/infrastructure`, html_url: `https://github.com/${repo}` },
    });
    const items = pollers.notificationItems(
      [thread("NorskRikstoto"), thread("mortennordbye")],
      ["norskrikstoto"],
    );
    expect(items.map((i) => `${i.from}: ${i.title}`)).toEqual([
      "infrastructure: a client's branch",
    ]);
  });

  it("deletes what a newly blocked owner left behind, and leaves the rest", async () => {
    await feed.upsert({
      ...seen("github:1"),
      title: "NorskRikstoto/infrastructure: fix(otel)",
    });
    await feed.upsert({ ...seen("github:2"), title: "mortennordbye/homelab: chore(helm)" });
    await feed.upsert({ ...seen("github:queue:demo#3"), title: "demo #3: tidy the readme" });

    await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { blockedOwners: ["NorskRikstoto"] },
    });

    const items = await feed.list();
    expect(items.map((i) => i.id).sort()).toEqual(["github:2", "github:queue:demo#3"]);
    const settings = (await app.inject({ url: "/api/settings" })).json();
    expect(settings.blockedOwners).toEqual(["norskrikstoto"]);
  });

  it("refuses an owner that is not a GitHub login", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { blockedOwners: ["not an owner/repo"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("ends a routine run once a later one has replaced it, and keeps the loud ones", async () => {
    const fired = (at: string, urgency: "quiet" | "attention") =>
      feed.upsert({
        id: `schedule:sch-a:${at}`,
        source: "schedule" as const,
        at,
        title: "nightly render",
        detail: urgency === "quiet" ? "ok" : "attention: nothing rendered",
        link: "/runs",
        version: "1",
        urgency,
      });
    await fired("2026-08-30T00:00:00.000Z", "quiet");
    await fired("2026-08-31T00:00:00.000Z", "attention");
    await fired("2026-09-01T00:00:00.000Z", "quiet");
    await fired("2026-09-02T00:00:00.000Z", "quiet");

    await pollers.pollBench();

    const state = async (at: string) => (await feed.get(`schedule:sch-a:${at}`))!.state;
    // The two routine ones a later run replaced are history.
    expect(await state("2026-08-30T00:00:00.000Z")).toBe("done");
    expect(await state("2026-09-01T00:00:00.000Z")).toBe("done");
    // The one that needed someone stays until someone deals with it, and the
    // newest is the row the screen is for.
    expect(await state("2026-08-31T00:00:00.000Z")).toBe("new");
    expect(await state("2026-09-02T00:00:00.000Z")).toBe("new");
    expect((await feed.get("schedule:sch-a:2026-08-30T00:00:00.000Z"))!.did).toBe("a later run");
  });

  it("closes a loop once the item it came from is done, and leaves the rest", async () => {
    await feed.upsert(seen("github:9"));
    const fromItem = await loops.open({ what: "review the PR", from: "github:9" });
    const byHand = await loops.open({ what: "book the ferry", from: "you" });
    const stillOpen = await loops.open({ what: "answer Kari", from: "github:10" });
    await feed.upsert(seen("github:10"));

    await feed.setState("github:9", "done");
    await pollers.pollBench();

    expect((await loops.get(fromItem.slug))!.state).toBe("closed");
    expect((await loops.get(byHand.slug))!.state).toBe("open");
    expect((await loops.get(stillOpen.slug))!.state).toBe("open");
  });

  it("ends a github item once its pull request is closed, and keeps the open one", async () => {
    const arrived = (n: number) =>
      feed.upsert({
        id: `github:${n}`,
        source: "github" as const,
        at: new Date().toISOString(),
        title: `o/r: pull ${n}`,
        detail: "your review was asked for",
        link: `https://github.com/o/r/pull/${n}`,
        version: "1",
      });
    await arrived(1);
    await arrived(2);
    fake.reply("gh", "api", { stdout: JSON.stringify([{ number: 2 }]) });
    fake.reply("gh", "api", { contains: "notifications", stdout: "[]" });

    await pollers.pollGithub(log);

    expect((await feed.get("github:1"))!.state).toBe("done");
    expect((await feed.get("github:1"))!.did).toBe("closed on GitHub");
    expect((await feed.get("github:2"))!.state).toBe("new");
    // One call for the repository, not one per item.
    const asked = fake.argvFor("gh").filter((a) => a[1]?.startsWith("repos/"));
    expect(asked).toEqual([["api", "repos/o/r/issues?state=open&per_page=100"]]);
  });

  it("ends a mail item once the message has been filed, and only inside the window", () => {
    const at = (min: number) => new Date(Date.parse("2026-09-03T09:00:00Z") - min * 60_000);
    const item = (uid: number, min: number) =>
      ({
        id: `mail:${uid}`,
        source: "mail",
        at: at(min).toISOString(),
        state: "new",
      }) as FeedItem;
    const seen = pollers.mailItems([
      {
        uid: 5,
        subject: "Hei",
        from: "Kari",
        address: "k@e.no",
        at: at(1).toISOString(),
        unread: true,
      },
      {
        uid: 3,
        subject: "Ordre",
        from: "Butikk",
        address: "b@e.no",
        at: at(30).toISOString(),
        unread: false,
      },
    ]);
    const over = pollers.filedAway(seen, [
      item(5, 1),
      // Inside the window and no longer in the inbox: filed.
      item(4, 10),
      // Older than the oldest message read, so its absence says nothing.
      item(1, 90),
      { ...item(2, 5), state: "done" },
      // The poller's own error row is not a message.
      { ...item(0, 5), id: "mail:poller" },
    ]);
    expect(over).toEqual(["mail:4"]);
    // Nothing to compare against is nothing filed, not everything filed.
    expect(pollers.filedAway([], [item(5, 1)])).toEqual([]);
  });

  it("ends anything a week unread, whatever it points at", async () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    await feed.upsert({
      id: "github:stale",
      source: "github",
      at: old,
      title: "o/r: a mention nobody read",
      detail: "",
      link: "https://github.com/o/r",
      version: "1",
    });
    fake.reply("gh", "api", { stdout: "[]" });

    await pollers.pollGithub(log);

    const item = (await feed.get("github:stale"))!;
    expect([item.state, item.did]).toEqual(["done", "a week unread"]);
  });

  it("leaves a repository it cannot read, and one with a full page of open work", async () => {
    for (const [id, repo] of [
      ["github:10", "o/unreadable"],
      ["github:11", "o/busy"],
    ]) {
      await feed.upsert({
        id,
        source: "github",
        at: new Date().toISOString(),
        title: `${repo}: pull 1`,
        detail: "",
        link: `https://github.com/${repo}/pull/1`,
        version: "1",
      });
    }
    fake.reply("gh", "api", { contains: "notifications", stdout: "[]" });
    fake.reply("gh", "api", { contains: "o/unreadable", code: 1, stderr: "gh: not found" });
    // A hundred open, so "not on the list" no longer means closed.
    fake.reply("gh", "api", {
      contains: "o/busy",
      stdout: JSON.stringify(Array.from({ length: 100 }, (_, n) => ({ number: n + 2 }))),
    });

    await pollers.pollGithub(log);

    expect((await feed.get("github:10"))!.state).toBe("new");
    expect((await feed.get("github:11"))!.state).toBe("new");
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
