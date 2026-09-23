import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionChat } from "../../shared/api";

const api = vi.fn();
vi.mock("../src/api", () => ({ api: (...args: unknown[]) => api(...args) }));

const { settle, useSessionChat } = await import("../src/useSessionChat");

const EMPTY: SessionChat = {
  conversationId: "c",
  messages: [],
  pending: [],
  todos: [],
  permissionMode: "",
  truncated: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("settle (C-14)", () => {
  const now = 1_000_000;

  it("clears one echo per message said, so a message sent twice shows twice until both land", () => {
    const echoes = [
      { text: "yes", at: now - 2 },
      { text: "yes", at: now - 1 },
    ];
    expect(settle(echoes, ["yes"], now)).toEqual([{ text: "yes", at: now - 1 }]);
    expect(settle(echoes, ["yes", "yes"], now)).toEqual([]);
  });

  it("matches what the transcript keeps, which is trimmed", () => {
    expect(settle([{ text: "look at a.png ", at: now }], ["look at a.png"], now)).toEqual([]);
  });

  it("hands back the same array when nothing was answered, and lets a stale echo go", () => {
    const echoes = [{ text: "hi", at: now }];
    expect(settle(echoes, ["other"], now)).toBe(echoes);
    expect(settle([{ text: "hi", at: now - 91_000 }], [], now)).toEqual([]);
  });
});

describe("useSessionChat (C-25)", () => {
  it("asks again only once the last answer is in, however slow it is", async () => {
    let answer: (chat: SessionChat) => void = () => {};
    api.mockImplementation(() => new Promise<SessionChat>((resolve) => (answer = resolve)));
    renderHook(() => useSessionChat("vk-a-1"));
    expect(api).toHaveBeenCalledTimes(1);

    // Fifteen seconds of a tunnel that has not answered: still the one request.
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => answer(EMPTY));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("reads at once when the screen comes back", async () => {
    api.mockResolvedValue(EMPTY);
    renderHook(() => useSessionChat("vk-a-1"));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api).toHaveBeenCalledTimes(1);

    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(api).toHaveBeenCalledTimes(2);
  });

  it("stores an echo trimmed", () => {
    api.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useSessionChat("vk-a-1"));
    act(() => result.current.echo("see a.png "));
    expect(result.current.echoes.map((e) => e.text)).toEqual(["see a.png"]);
  });
});
