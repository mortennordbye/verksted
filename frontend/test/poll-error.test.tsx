import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import { resetStream } from "../src/events";
import Inbox from "../src/screens/Inbox";

/**
 * F-29. Of the forty-odd `usePoll` call sites outside the chat, two read
 * `error` — so a pod answering 500 for a list looked exactly like a pod with
 * nothing on it. "Nothing needs you" is a claim, and a feed that could not be
 * read is not that claim.
 */
let fetchMock: ReturnType<typeof vi.fn>;
let broken: boolean;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  broken = true;
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/feed")) {
      return Promise.resolve(broken ? json({ error: "feed is unreadable" }, 500) : json([]));
    }
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  resetStream();
  vi.unstubAllGlobals();
});

const draw = () =>
  render(
    <MemoryRouter>
      <Inbox />
    </MemoryRouter>,
  );

describe("a list the pod could not read", () => {
  it("says so instead of showing an empty list", async () => {
    draw();
    const row = await screen.findByRole("alert");
    expect(row.textContent).toContain("could not read the inbox");
    expect(row.textContent).toContain("feed is unreadable");
  });

  it("offers the read again, and goes away when it works", async () => {
    draw();
    await screen.findByRole("alert");
    broken = false;

    fireEvent.click(screen.getByRole("button", { name: "try again" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  /**
   * An unreachable pod is the connection banner's business, and it is already
   * on screen saying it. One interruption per outage.
   */
  it("stays quiet when nothing answered at all", async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    draw();

    // Long enough for the failure to have landed and rendered.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
