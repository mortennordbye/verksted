import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantThread } from "../../shared/api";
import { useAssistantStream } from "../src/useAssistantStream";

/**
 * A socket that can be dropped on purpose.
 *
 * Every instance is kept, because the whole question here is what happens
 * *after* the first one dies: how many more were opened, and when.
 */
class FakeSocket {
  static opened: FakeSocket[] = [];
  static get last(): FakeSocket {
    return FakeSocket.opened[FakeSocket.opened.length - 1];
  }
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public url: string) {
    FakeSocket.opened.push(this);
  }

  /** The server accepting the upgrade. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** One frame, as the route sends it: the whole thread, every time. */
  send(thread: AssistantThread): void {
    this.onmessage?.({ data: JSON.stringify(thread) } as MessageEvent<string>);
  }

  /** The phone going to sleep, the pod restarting, WireGuard dropping. */
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  close(): void {
    this.readyState = 3;
  }
}

const thread = (over: Partial<AssistantThread> = {}): AssistantThread => ({
  conversationId: "11111111-1111-4111-8111-111111111111",
  status: "idle",
  entries: [],
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.opened = [];
  fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(thread({ status: "idle" })), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useAssistantStream", () => {
  it("takes the thread from the frames it is sent", async () => {
    const { result } = renderHook(() => useAssistantStream());
    expect(FakeSocket.opened).toHaveLength(1);
    expect(FakeSocket.last.url).toContain("/api/assistant/stream");

    act(() => {
      FakeSocket.last.open();
      FakeSocket.last.send(thread({ status: "thinking", live: "one mo" }));
    });
    expect(result.current.streaming).toBe(true);
    expect(result.current.thread?.live).toBe("one mo");
  });

  /**
   * The bug this pins. The screen used to open exactly one socket and never
   * look at it again: a phone that slept mid-turn came back to a dead
   * connection, a thread frozen on "thinking", and a composer that queued
   * everything typed into it until the page was reloaded.
   */
  it("opens another socket after one drops, and backs off while it cannot", async () => {
    const { result } = renderHook(() => useAssistantStream());
    act(() => FakeSocket.last.open());

    act(() => FakeSocket.last.drop());
    expect(result.current.streaming).toBe(false);
    // Not immediately: a pod that is restarting would be hammered.
    expect(FakeSocket.opened).toHaveLength(1);

    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(FakeSocket.opened).toHaveLength(2);

    // A second failure waits longer than the first.
    act(() => FakeSocket.last.drop());
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(FakeSocket.opened).toHaveLength(2);
    await act(async () => void (await vi.advanceTimersByTimeAsync(1000)));
    expect(FakeSocket.opened).toHaveLength(3);

    // And once it lands, the thread is whole again.
    act(() => {
      FakeSocket.last.open();
      FakeSocket.last.send(thread({ status: "idle" }));
    });
    expect(result.current.streaming).toBe(true);
    expect(result.current.thread?.status).toBe("idle");
  });

  it("tries again at once when the screen comes back, rather than waiting out the backoff", async () => {
    renderHook(() => useAssistantStream());
    act(() => FakeSocket.last.open());
    act(() => FakeSocket.last.drop());
    // Four failures in: the next try is a long way off.
    for (let i = 0; i < 3; i++) {
      await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
      act(() => FakeSocket.last.drop());
    }
    const before = FakeSocket.opened.length;

    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeSocket.opened.length).toBe(before + 1);
  });

  /**
   * The half that matters even when nothing reconnects: without this, a turn
   * that ended while the socket was down is still "thinking" on screen, and
   * the send queue behind it never drains.
   */
  it("asks for the thread outright while there is no socket, and stops once there is", async () => {
    const { result } = renderHook(() => useAssistantStream());
    act(() => {
      FakeSocket.last.open();
      FakeSocket.last.send(thread({ status: "thinking" }));
    });
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => FakeSocket.last.drop());
    await act(async () => void (await vi.advanceTimersByTimeAsync(5000)));
    expect(fetchMock).toHaveBeenCalledWith("/api/assistant", expect.anything());
    expect(result.current.thread?.status).toBe("idle");

    const asked = fetchMock.mock.calls.length;
    act(() => {
      FakeSocket.last.open();
    });
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(fetchMock.mock.calls.length).toBe(asked);
  });

  it("stops reconnecting once the screen is gone", async () => {
    const { unmount } = renderHook(() => useAssistantStream());
    act(() => FakeSocket.last.open());
    unmount();
    act(() => FakeSocket.last.drop());
    await act(async () => void (await vi.advanceTimersByTimeAsync(60_000)));
    expect(FakeSocket.opened).toHaveLength(1);
  });
});
