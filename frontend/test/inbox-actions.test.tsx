import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "../../shared/api";
import { resetPollCache } from "../src/api";
import Inbox from "../src/screens/Inbox";

/**
 * F-07. The inbox had no error state anywhere: every tap on a row went through
 * an `act()` that was try/finally with no catch, so a POST the pod refused —
 * or never received, which over a tunnel that has dropped is the same thing —
 * left the row exactly as it was and the rejection in the console. "Done"
 * simply did nothing, and the undo bar offered back an item that was never
 * marked.
 */
const item: FeedItem = {
  id: "github-1",
  source: "github",
  urgency: "new",
  state: "new",
  title: "review the parser PR",
  detail: "opened by someone",
  facts: [],
  at: new Date().toISOString(),
  until: null,
  link: null,
  loop: null,
  did: null,
  triaged: true,
  pushed: false,
  version: "1",
  from: null,
};

let fetchMock: ReturnType<typeof vi.fn>;
let refuse: boolean;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  refuse = true;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      return Promise.resolve(refuse ? json({ error: "no such item" }, 409) : json({}));
    }
    if (url.startsWith("/api/feed")) return Promise.resolve(json([item]));
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
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

/** The row's own buttons: "done" is also the name of the list's filter. */
const row = async (title: string) => {
  const found = (await screen.findByText(title)).closest("[id]");
  return within(found as HTMLElement);
};

/** The row a title is on, whether or not it is showing. */
const rowOf = (title: string) => screen.getByText(title).closest("[id]") as HTMLElement;

describe("a row the pod refuses", () => {
  it("says so, and offers no undo for what did not happen", async () => {
    draw();
    const one = await row("review the parser PR");
    fireEvent.click(one.getByRole("button", { name: "done" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no such item");
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
  });

  it("offers the undo once it did", async () => {
    refuse = false;
    draw();
    const one = await row("review the parser PR");
    fireEvent.click(one.getByRole("button", { name: "done" }));

    expect(await screen.findByRole("button", { name: "undo" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  /** The same hole one level up: clearing the list swallowed its own failure. */
  it("says so when the list's own clear fails", async () => {
    const many = [item, { ...item, id: "github-2", title: "second thing" }];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(json({ error: "volume is full" }, 500));
      if (url.startsWith("/api/feed")) return Promise.resolve(json(many));
      return Promise.resolve(json([]));
    });
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "clear 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "mark 2 done" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("volume is full"));
    expect(screen.queryByRole("button", { name: "undo" })).toBeNull();
    // And the rows it had hidden on the tap are back.
    expect(rowOf("second thing").hidden).toBe(false);
  });
});

/**
 * F-32. Every triage tap was two round trips over WireGuard before anything
 * moved — the POST, then the list read back — and "clear" was a POST per row.
 */
describe("a tap on the list", () => {
  it("takes the row away before the pod has answered", async () => {
    let answer: ((r: Response) => void) | undefined;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return new Promise<Response>((r) => (answer = r));
      if (url.startsWith("/api/feed")) return Promise.resolve(json([item]));
      return Promise.resolve(json([]));
    });
    draw();
    const one = await row("review the parser PR");
    fireEvent.click(one.getByRole("button", { name: "done" }));

    // Nothing has come back yet, and the row is already out of the way —
    // hidden rather than removed, so a refusal can bring it back with a reason.
    await waitFor(() => expect(rowOf("review the parser PR").hidden).toBe(true));
    expect(answer).toBeTruthy();
  });

  it("puts it back, with the reason, when the pod refuses", async () => {
    draw();
    const one = await row("review the parser PR");
    fireEvent.click(one.getByRole("button", { name: "done" }));

    expect((await screen.findByRole("alert")).textContent).toContain("no such item");
    expect(rowOf("review the parser PR").hidden).toBe(false);
  });

  it("clears a whole list in one request", async () => {
    refuse = false;
    const many = [item, { ...item, id: "github-2", title: "second thing" }];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === "POST") return Promise.resolve(json({ changed: many.map((i) => i.id) }));
      if (url.startsWith("/api/feed")) return Promise.resolve(json(many));
      return Promise.resolve(json([]));
    });
    draw();
    fireEvent.click(await screen.findByRole("button", { name: "clear 2" }));
    fireEvent.click(await screen.findByRole("button", { name: "mark 2 done" }));

    expect((await screen.findByRole("status")).textContent).toContain("2 marked done");
    const posts = (fetchMock.mock.calls as [string, RequestInit?][]).filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts.map(([url]) => url)).toEqual(["/api/feed/state"]);
    expect(JSON.parse(posts[0][1]!.body as string)).toEqual({
      ids: ["github-1", "github-2"],
      state: "done",
    });
  });
});
