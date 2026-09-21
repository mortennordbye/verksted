import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import { resetStream } from "../src/events";
import CommandPalette from "../src/components/CommandPalette";
import Docs from "../src/screens/Docs";

/**
 * Two screens that asked the pod for more than they needed: F-17, which
 * searched the whole share once per keystroke, and F-20, which fetched a
 * session list per project although the app already holds them all.
 */
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const asked = (match: string) =>
  (fetchMock.mock.calls as [string][]).map(([url]) => url).filter((url) => url.includes(match));

beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/docs/search")) return Promise.resolve(json([]));
    if (url.startsWith("/api/docs")) return Promise.resolve(json([]));
    if (url === "/api/projects") return Promise.resolve(json([{ name: "demo", branch: "main" }]));
    if (url === "/api/sessions") {
      return Promise.resolve(
        json([
          {
            id: "vk-demo-1",
            project: "demo",
            agent: "claude",
            title: "fix the parser",
            status: "running",
          },
        ]),
      );
    }
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", undefined);
  // jsdom has no layout, so it has no scrollIntoView either; the palette moves
  // its highlight with one.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  resetPollCache();
  resetStream();
  vi.unstubAllGlobals();
});

describe("searching the share", () => {
  it("waits for the typing to stop before asking", async () => {
    render(
      <MemoryRouter>
        <Docs />
      </MemoryRouter>,
    );
    const box = screen.getByPlaceholderText("search the text of every document…");
    for (const value of ["r", "re", "rep", "repo"]) {
      fireEvent.change(box, { target: { value } });
    }

    await waitFor(() => expect(asked("/api/docs/search")).toHaveLength(1));
    // The word that was typed, not the four prefixes on the way to it: each of
    // these is a full-text search of the share on the pod.
    expect(asked("/api/docs/search")[0]).toContain("q=repo");
  });
});

describe("the jump-to palette", () => {
  it("reads the lists the app already has, not one per project", async () => {
    render(
      <MemoryRouter>
        <CommandPalette onClose={() => undefined} />
      </MemoryRouter>,
    );

    expect(await screen.findByText("fix the parser")).toBeTruthy();
    expect(screen.getByText("~/demo")).toBeTruthy();
    expect(asked("/api/sessions")).toHaveLength(1);
    // A bench with eight repos used to make nine requests per open.
    expect(asked("/sessions?")).toHaveLength(0);
    expect(asked("/api/projects/")).toHaveLength(0);
  });
});
