import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../src/App";
import { resetPollCache } from "../src/api";
import { resetStream } from "../src/events";

/**
 * F-43. A tapped notification used to reach the app as `client.navigate`,
 * which is a full document load: the terminal's websocket, the event stream
 * and anything typed and unsent go with it — including when the app was
 * already on the session the notification was about, which is the common case.
 * The worker sends the path now and the app routes to it.
 */
const worker = new EventTarget();

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(new Response("[]", { headers: { "content-type": "application/json" } })),
    ),
  );
  vi.stubGlobal("EventSource", undefined);
  // jsdom has neither, and the hub asks about both on the way up.
  vi.stubGlobal("matchMedia", (media: string) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  Object.defineProperty(navigator, "serviceWorker", { value: worker, configurable: true });
});

afterEach(() => {
  cleanup();
  resetPollCache();
  resetStream();
  vi.unstubAllGlobals();
});

const send = (data: unknown) =>
  act(() => {
    const event = new Event("message") as Event & { data: unknown };
    event.data = data;
    worker.dispatchEvent(event);
  });

describe("a notification tapped while the app is open", () => {
  it("routes inside the app instead of reloading it", async () => {
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("The share")).toBeTruthy();

    send({ type: "navigate", url: "/runs" });

    expect(await screen.findByText("Nothing needs you")).toBeTruthy();
  });

  /**
   * The path arrives from the push service, so it is checked at this end as
   * well as in the worker: a router that goes wherever it is told is worth
   * attacking. `/\evil.example` parses as an authority, not a path.
   */
  it("refuses a path that leads off this origin", async () => {
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("The share")).toBeTruthy();

    send({ type: "navigate", url: "/\\evil.example/steal" });

    // It lands on "/", which is Today or the bench — never on a path the push
    // service chose.
    expect(screen.queryByText("No such page")).toBeNull();
  });

  it("ignores a message that is not one of ours", async () => {
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByText("The share")).toBeTruthy();

    send({ type: "SKIP_WAITING" });
    send(null);

    expect(screen.getByText("The share")).toBeTruthy();
  });
});

/**
 * F-35. The jump-to palette opened on Cmd/Ctrl+K and nothing else, which is
 * no way in at all on a phone — and nothing on a desk said it was there.
 */
describe("the jump-to palette", () => {
  it("opens from the top bar, without a keyboard", async () => {
    // jsdom has no layout, so no scrollIntoView; the palette moves its
    // highlight with one.
    Element.prototype.scrollIntoView = vi.fn();
    render(
      <MemoryRouter initialEntries={["/docs"]}>
        <App />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "search…" }));
    expect(await screen.findByRole("dialog", { name: "Search" })).toBeTruthy();
  });
});
