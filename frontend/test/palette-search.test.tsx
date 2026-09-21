import { useEffect } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, Session } from "../../shared/api";
import { resetPollCache } from "../src/api";
import App from "../src/App";
import CommandPalette from "../src/components/CommandPalette";
import { resetStream } from "../src/events";

/**
 * F-49: the palette as a search over everything the app keeps, and a sheet
 * with every key it answers to.
 */
const finished = {
  id: "vk-demo-7",
  title: "rewrite the parser",
  project: "demo",
  agent: "claude",
  status: "done",
} as Session;

const mail = {
  id: "mail:42",
  source: "mail",
  title: "the invoice from the landlord",
  from: "Landlord AS",
  state: "new",
} as FeedItem;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let docSearches: string[];

beforeEach(() => {
  docSearches = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url.startsWith("/api/sessions")) return Promise.resolve(json([finished]));
      if (url.startsWith("/api/feed")) return Promise.resolve(json([mail]));
      if (url.startsWith("/api/docs/search")) {
        docSearches.push(url);
        return Promise.resolve(json([{ path: "house/lease.pdf", excerpt: "the rent is due" }]));
      }
      return Promise.resolve(json([]));
    }),
  );
  vi.stubGlobal("EventSource", undefined);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  resetStream();
  vi.unstubAllGlobals();
});

const seen = { where: "" };
function Where() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    seen.where = pathname + search + hash;
  }, [pathname, search, hash]);
  return null;
}

const palette = () =>
  render(
    <MemoryRouter initialEntries={["/bench"]}>
      <CommandPalette onClose={() => {}} />
      <Where />
    </MemoryRouter>,
  );

const type = (text: string) =>
  fireEvent.change(screen.getByRole("combobox"), { target: { value: text } });

describe("the palette", () => {
  it("finds a session that has finished, not only the live ones", async () => {
    palette();
    type("parser");
    fireEvent.click(await screen.findByText("rewrite the parser"));
    expect(seen.where).toBe("/s/vk-demo-7");
  });

  it("finds what is in the inbox, by what it is about or who sent it", async () => {
    palette();
    type("landlord");
    fireEvent.click(await screen.findByText("the invoice from the landlord"));
    expect(seen.where).toBe("/runs#mail%3A42");
  });

  it("searches the documents once there is something to search for", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      palette();
      type("r");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      expect(docSearches).toEqual([]);
      type("rent");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      fireEvent.click(await screen.findByText("lease.pdf"));
      expect(docSearches).toHaveLength(1);
      expect(seen.where).toBe("/docs?doc=house%2Flease.pdf");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the shortcut sheet", () => {
  it("opens on ?, and not while a field is being typed in", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <App />
      </MemoryRouter>,
    );
    const field = await screen.findByRole("textbox", { name: "search the documents" });
    fireEvent.keyDown(field, { key: "?" });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();

    fireEvent.keyDown(document.body, { key: "?" });
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy(),
    );
  });
});
