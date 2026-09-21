import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import BrowserPane from "../src/components/BrowserPane";

/**
 * F-19. The browser pane paints screenshots the pod pushes at it, and relays
 * the pointer back. Both halves did more than the far end could use: every
 * frame got its own decode, and a decode finishes whenever the browser gets to
 * it — so a slower older frame could land on top of a newer one and leave the
 * pane showing the page as it was. And a mouse reports where it is hundreds of
 * times a second, each report its own frame over the tunnel.
 */
class FakeSocket {
  static open: FakeSocket[] = [];
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.open.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  deliver(msg: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(msg) }));
  }
}

/** A decode the pane asked for, finished by hand rather than by a browser. */
type Decode = { body: string; load: () => void; fail: () => void };

let decodes: Decode[] = [];
let painted: string[] = [];

const frame = (data: string) => ({ t: "frame", data, w: 1280, h: 800 });
const body = (src: string) => src.split(",")[1];
const moves = (ws: FakeSocket) =>
  ws.sent
    .map((s) => JSON.parse(s) as Record<string, unknown>)
    .filter((m) => m.type === "mouseMoved");

beforeEach(() => {
  FakeSocket.open = [];
  decodes = [];
  painted = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("[]"))),
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );

  // jsdom decodes nothing and draws nothing. Setting `src` is where a real
  // browser would start a decode, so that is where this one records it — and
  // it is finished by hand, which is the only way to land two of them in an
  // order they were not started in.
  Object.defineProperty(window.Image.prototype, "src", {
    configurable: true,
    set(this: HTMLImageElement, value: string) {
      decodes.push({
        body: body(value),
        load: () => act(() => this.onload?.(new Event("load"))),
        fail: () => act(() => this.onerror?.(new Event("error"))),
      });
      Object.defineProperty(this, "src", { value, configurable: true });
    },
  });
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    drawImage: (img: HTMLImageElement) => painted.push(body(img.src)),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Without a box there is nothing to map a pointer into, and every coordinate
  // comes out NaN.
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 640,
    height: 400,
  } as DOMRect);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const draw = () => render(<BrowserPane wsPath="/api/sessions/vk-demo-1/browser" />);

describe("frames arriving faster than they can be decoded", () => {
  it("decodes one at a time, and skips the ones nobody would have seen", async () => {
    const ws = (draw(), FakeSocket.open[0]);

    ws.deliver(frame("one"));
    expect(decodes.map((d) => d.body)).toEqual(["one"]);
    // Two more while the first is still going. Neither is started, so neither
    // can finish out of turn.
    ws.deliver(frame("two"));
    ws.deliver(frame("three"));
    expect(decodes).toHaveLength(1);

    decodes[0].load();
    // The middle one is gone, not the newest: a frame nobody was ever going to
    // see is not worth decoding, and on a phone the decode is the bottleneck.
    await waitFor(() => expect(decodes.map((d) => d.body)).toEqual(["one", "three"]));

    decodes[1].load();
    expect(painted).toEqual(["one", "three"]);
  });

  it("carries on after a frame that will not decode", async () => {
    const ws = (draw(), FakeSocket.open[0]);

    ws.deliver(frame("truncated"));
    ws.deliver(frame("after"));
    decodes[0].fail();

    // A half-received JPEG used to be harmless because each frame had its own
    // Image. With one queue it would stop every frame behind it.
    await waitFor(() => expect(decodes.map((d) => d.body)).toEqual(["truncated", "after"]));
    decodes[1].load();
    expect(painted).toEqual(["after"]);
  });
});

describe("a pointer moving across the pane", () => {
  it("relays one position per animation frame, not one per report", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => undefined);

    const ws = (draw(), FakeSocket.open[0]);
    const canvas = document.querySelector("canvas")!;
    for (let x = 1; x <= 20; x++) fireEvent.mouseMove(canvas, { clientX: x * 10, clientY: 5 });

    // Twenty reports, one frame asked for, nothing sent yet.
    expect(moves(ws)).toHaveLength(0);
    expect(frames).toHaveLength(1);

    act(() => frames[0](0));
    expect(moves(ws)).toHaveLength(1);
    // And it carries where the pointer is now, not where it was twenty
    // reports ago: 200 CSS px of a 640 px box, mapped onto a 1280 px page.
    expect(moves(ws)[0].x).toBe(400);
  });
});
