import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Proposals and intake: the tap, and the way in from outside the app.
 *
 * What is pinned is that a proposal is checked before anyone sees it, shown
 * whole, executed only through `do` and through the app's own route, dropped
 * without a trace on the other side, and expired when nobody tapped it. The
 * sending kinds answer "not set up" rather than failing when there is no
 * server to send through.
 */
let app: FastifyInstance;
let feed: typeof import("../src/feed-store.js");

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-proposals-"));
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sched-"));
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-repos-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-sess-"));
  process.env.PUSH_FILE = path.join(dir, "push.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
  feed = await import("../src/feed-store.js");
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  fs.mkdirSync(process.env.FEED_DIR!, { recursive: true });
  for (const f of fs.readdirSync(process.env.FEED_DIR!))
    fs.rmSync(path.join(process.env.FEED_DIR!, f));
});

const propose = (action: Record<string, unknown>, why?: string) =>
  app.inject({
    method: "POST",
    url: "/api/proposals",
    payload: { action, ...(why ? { why } : {}) },
  });

describe("a proposal", () => {
  it("is checked before it is shown, and shown whole", async () => {
    const bad = await propose({ kind: "send", to: "not an address", subject: "x", body: "y" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/addresses/);
    expect(
      (
        await propose({
          kind: "calendar_put",
          summary: "x",
          start: "2026-09-01T10:00:00Z",
          end: "2026-09-01T09:00:00Z",
        })
      ).statusCode,
    ).toBe(400);
    expect((await propose({ kind: "nothing" })).statusCode).toBe(400);

    const ok = await propose(
      { kind: "send", to: "kari@example.no", subject: "Hytta", body: "Ja, vi kommer.\nHilsen M" },
      "she asked twice",
    );
    expect(ok.statusCode).toBe(201);
    const item = ok.json();
    expect(item.source).toBe("proposal");
    expect(item.urgency).toBe("attention");
    expect(item.triaged).toBe(true);
    expect(item.title).toBe("Send to kari@example.no: Hytta");
    expect(item.detail).toBe("she asked twice\n\nJa, vi kommer.\nHilsen M");
    expect(item.action).toEqual({
      kind: "send",
      to: "kari@example.no",
      subject: "Hytta",
      body: "Ja, vi kommer.\nHilsen M",
    });
    expect(item.link).toBe(`/runs#${item.id}`);
  });

  it("does nothing until tapped, and then goes through the app's own route", async () => {
    const schedule = (
      await app.inject({
        method: "POST",
        url: "/api/schedules",
        payload: { name: "old", kind: "assistant", cron: "0 7 * * *", prompt: "x" },
      })
    ).json();
    const { id } = (await propose({ kind: "delete_schedule", id: schedule.id })).json();
    const ids = async () =>
      (await app.inject({ url: "/api/schedules" })).json().map((s: { id: string }) => s.id);
    expect(await ids()).toContain(schedule.id);

    const done = await app.inject({ method: "POST", url: `/api/proposals/${id}/do` });
    expect(done.statusCode).toBe(200);
    expect(done.json().state).toBe("done");
    expect(done.json().did).toBe(`deleted schedule ${schedule.id}`);
    expect(await ids()).not.toContain(schedule.id);

    // A second tap is refused rather than repeated.
    expect((await app.inject({ method: "POST", url: `/api/proposals/${id}/do` })).statusCode).toBe(
      409,
    );
  });

  it("says sending is not set up rather than failing, and leaves the card", async () => {
    const { id } = (await propose({ kind: "send", to: "a@b.no", subject: "s", body: "b" })).json();
    const res = await app.inject({ method: "POST", url: `/api/proposals/${id}/do` });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatch(/SMTP_HOST/);
    expect((await feed.get(id))!.state).toBe("new");
  });

  it("drops without doing, and expires when nobody tapped", async () => {
    const { id } = (await propose({ kind: "end_session", id: "vk-demo-1" })).json();
    const dropped = await app.inject({ method: "POST", url: `/api/proposals/${id}/drop` });
    expect(dropped.json().did).toBe("dropped");

    const { id: stale } = (await propose({ kind: "end_session", id: "vk-demo-2" })).json();
    await feed.sweep(Date.now() + 4 * 86_400_000);
    expect((await feed.get(stale))!.did).toBe("expired untapped");
  });
});

describe("intake", () => {
  it("files what was shared as yours, for triage to read", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/intake",
      payload: { title: "Forsikring", url: "https://example.no/tilbud" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      source: "intake",
      title: "from you: Forsikring",
      link: "https://example.no/tilbud",
      triaged: false,
    });
    expect((await app.inject({ method: "POST", url: "/api/intake", payload: {} })).statusCode).toBe(
      400,
    );
  });
});
