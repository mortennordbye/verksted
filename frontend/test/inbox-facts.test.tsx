import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, FeedItemFacts } from "../../shared/api";
import { resetPollCache } from "../src/api";
import Inbox from "../src/screens/Inbox";

/**
 * The facts an opened row fetches: asked for on the first open and not before,
 * asked for once however often the row is opened, and drawn into the facts
 * line beside what the poller already wrote.
 */
const pr: FeedItem = {
  id: "github:602",
  source: "github",
  urgency: "new",
  state: "new",
  title: "update cluster",
  detail: "",
  from: "homelab",
  facts: ["PullRequest", "your review was asked for"],
  at: new Date().toISOString(),
  until: null,
  link: "https://github.com/o/homelab/pull/602",
  loop: null,
  did: null,
  triaged: true,
  pushed: false,
  version: "1",
};

const run: FeedItem = {
  ...pr,
  id: "schedule:sch-00000001:2026-09-20T07:00:00.000Z",
  source: "schedule",
  title: "morning briefing",
  from: null,
  facts: ["attention", "38k tokens"],
  link: "/s/vk-demo-3",
};

const FACTS: Record<string, FeedItemFacts> = {
  [pr.id]: {
    checks: "passing",
    diff: { additions: 248, deletions: 31, files: 5 },
    firstLine: null,
    durationMs: null,
    tokens: null,
  },
  [run.id]: { checks: null, diff: null, firstLine: null, durationMs: 252_000, tokens: 38_000 },
};

let factsAsked: string[];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  factsAsked = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const m = /^\/api\/feed\/([^/]+)\/facts$/.exec(url);
      if (m) {
        const id = decodeURIComponent(m[1] ?? "");
        factsAsked.push(id);
        return Promise.resolve(json(FACTS[id]));
      }
      if (url === "/api/feed") return Promise.resolve(json([pr, run]));
      return Promise.resolve(json([]));
    }),
  );
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const draw = () =>
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );

/** The row's own tap target, which is the button holding its title. */
const rowButton = async (title: string) =>
  (await screen.findByText(title)).closest("button") as HTMLElement;

describe("an opened row", () => {
  it("asks for nothing until it is opened", async () => {
    draw();
    await screen.findByText("update cluster");
    expect(factsAsked).toEqual([]);
  });

  it("shows a pull request's checks and size, and asks once", async () => {
    draw();
    const row = await rowButton("update cluster");
    fireEvent.click(row);
    // A skeleton while it is asked for, not "loading…" text.
    expect(row.querySelector(".animate-skeleton-in")).toBeTruthy();

    expect(await screen.findByText("✓ checks passing")).toBeTruthy();
    expect(row.querySelector(".animate-skeleton-in")).toBeNull();
    expect(row.textContent).toContain("+248");
    expect(row.textContent).toContain("−31");
    expect(row.textContent).toContain("5 files");

    fireEvent.click(row);
    fireEvent.click(row);
    expect(factsAsked).toEqual([pr.id]);
  });

  it("shows a run's time and leaves out the tokens its row already says", async () => {
    draw();
    const row = await rowButton("morning briefing");
    fireEvent.click(row);

    expect(await screen.findByText("ran 4 m 12 s")).toBeTruthy();
    expect(row.textContent?.match(/38k tokens/g)).toHaveLength(1);
  });
});
