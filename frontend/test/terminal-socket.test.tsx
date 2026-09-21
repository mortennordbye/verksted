import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Terminal from "../src/components/Terminal";

/**
 * F-02 and F-03. The terminal, the websocket and every listener on both were
 * one effect keyed on the retry counter, so each backoff attempt disposed the
 * xterm and built an empty one — and the "reconnecting" banner is written as a
 * banner rather than an overlay precisely so the last thing the agent printed
 * stays readable under it. The screen it was protecting was blank.
 *
 * The terminal now outlives its connection, which is also where a resize can
 * finally be reported from: `fit()` after a font change leaves the box the same
 * size, so the container's observer never fired and tmux kept the old geometry.
 */
class FakeSocket {
  static open: FakeSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.open.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  /** What the pod does on attach: accept, then repaint the pane. */
  accept(text?: string) {
    this.readyState = 1;
    act(() => this.onopen?.());
    if (text !== undefined) act(() => this.onmessage?.({ data: text }));
  }
  drop(code: number) {
    this.readyState = 3;
    act(() => this.onclose?.({ code }));
  }
}

const frames = (ws: FakeSocket) => ws.sent.map((s) => JSON.parse(s) as Record<string, unknown>);

beforeEach(() => {
  FakeSocket.open = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  // Neither of these exists in jsdom, and xterm asks for both on open.
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
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  // jsdom lays everything out at nothing: no box for the fit addon to divide
  // by, and no measurement for the cell it divides into. Both are given here,
  // the cell from the font size xterm writes onto the element it measures with
  // — which is what makes a font change move the geometry, as it does in a
  // browser.
  const styles = window.getComputedStyle.bind(window);
  vi.stubGlobal("getComputedStyle", (el: Element, pseudo?: string | null) => {
    const real = styles(el, pseudo);
    return {
      ...real,
      getPropertyValue: (name: string) =>
        name === "height"
          ? "600px"
          : name === "width"
            ? "800px"
            : name.startsWith("padding")
              ? "0px"
              : real.getPropertyValue(name),
    };
  });
  const cell = (el: HTMLElement) =>
    el.classList.contains("xterm-char-measure-element")
      ? Number.parseFloat(el.style.fontSize || "13")
      : 0;
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    // The element holds 32 characters, and xterm divides by 32.
    return Math.round(cell(this) * 0.6 * 32);
  });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return Math.round(cell(this) * 1.2);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draw = () => render(<Terminal sessionId="vk-demo-1" project="demo" />);

describe("a connection that drops", () => {
  it("keeps the screen the banner is written over", async () => {
    const { container } = draw();
    FakeSocket.open[0].accept("the agent said something");
    // xterm paints on an animation frame, not on the write.
    const onScreen = () => expect(container.textContent).toContain("the agent said something");
    await waitFor(onScreen);

    FakeSocket.open[0].drop(1006);
    const banner = await screen.findByText(/reconnecting/);
    // The whole point of the banner: what was on the pane is still on the pane.
    onScreen();

    fireEvent.click(banner);
    expect(FakeSocket.open).toHaveLength(2);
    onScreen();
  });

  it("does not reconnect to a session the pod says is gone", async () => {
    draw();
    FakeSocket.open[0].accept("");
    FakeSocket.open[0].drop(4404);

    expect(await screen.findByText(/this session has ended/)).toBeTruthy();
    expect(FakeSocket.open).toHaveLength(1);
  });
});

/**
 * F-09. The scan runs over the scrollback after every batch of output, so
 * dismissing the bar bought one line of quiet before the same URL — still in
 * the scrollback, where it stays — raised it again. The match is deliberately
 * wide, so a link in an agent's own prose could trip a bar that then could not
 * be got rid of for the rest of the session.
 */
describe("a sign-in link that was dismissed", () => {
  it("stays dismissed while it is still in the scrollback", async () => {
    draw();
    const ws = FakeSocket.open[0];
    ws.accept("open https://claude.ai/oauth/authorize?code=1 to sign in\r\n");

    fireEvent.click(await screen.findByLabelText("dismiss sign-in link"));
    expect(screen.queryByText("sign-in link")).toBeNull();

    ws.accept("the agent carried on printing\r\n");
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.queryByText("sign-in link")).toBeNull();
  });
});

describe("the pane's geometry", () => {
  it("reaches tmux when the font size changes it", async () => {
    draw();
    const ws = FakeSocket.open[0];
    ws.accept("");
    const before = frames(ws).filter((f) => f.t === "resize").length;

    fireEvent.click(screen.getByRole("button", { name: "more" }));
    fireEvent.click(await screen.findByRole("button", { name: "smaller text" }));

    const after = frames(ws).filter((f) => f.t === "resize");
    expect(after.length).toBeGreaterThan(before);
    expect(after.at(-1)!.cols).toBeTypeOf("number");
  });
});
