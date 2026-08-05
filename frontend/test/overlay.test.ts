import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyText } from "../src/clipboard";
import { useDismissOnBack } from "../src/useDismissOnBack";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** popstate is not fired by jsdom's history.back(), so drive it by hand. */
const goBack = async () => {
  await act(async () => {
    history.back();
    dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  });
};

describe("useDismissOnBack", () => {
  beforeEach(() => {
    history.replaceState(null, "", "/s/vk-demo-1");
  });

  it("adds a history entry while the overlay is open", () => {
    const before = history.length;
    renderHook(() => useDismissOnBack(true, () => {}));
    expect(history.length).toBeGreaterThan(before);
    expect((history.state as { vkOverlay?: boolean }).vkOverlay).toBe(true);
  });

  it("closes the overlay on Back instead of leaving the screen", async () => {
    const onClose = vi.fn();
    renderHook(() => useDismissOnBack(true, onClose));
    await goBack();
    expect(onClose).toHaveBeenCalledTimes(1);
    // Still on the same route: Back was spent on the overlay.
    expect(location.pathname).toBe("/s/vk-demo-1");
  });

  it("adds nothing while closed", () => {
    const before = history.length;
    renderHook(() => useDismissOnBack(false, () => {}));
    expect(history.length).toBe(before);
  });

  // Otherwise Back has to be pressed twice to leave the screen after cancelling.
  it("removes its entry when the overlay closes some other way", async () => {
    const { unmount } = renderHook(() => useDismissOnBack(true, () => {}));
    expect((history.state as { vkOverlay?: boolean }).vkOverlay).toBe(true);
    await act(async () => {
      unmount();
      // history.back() is queued as a task in jsdom, as it is in a browser.
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect((history.state as { vkOverlay?: boolean } | null)?.vkOverlay).toBeUndefined();
  });

  // Navigating away unmounts the overlay too, and popping our entry then would
  // yank the user back to the screen they just left.
  it("leaves history alone when the app navigated instead", async () => {
    const { unmount } = renderHook(() => useDismissOnBack(true, () => {}));
    // What react-router does on a route change: its own entry, its own state.
    history.pushState({ usr: null, key: "abc", idx: 2 }, "", "/p/demo");
    const length = history.length;
    await act(async () => {
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(location.pathname).toBe("/p/demo");
    expect(history.length).toBe(length);
  });

  it("does not re-push when the callback identity changes each render", () => {
    const { rerender } = renderHook(() => useDismissOnBack(true, () => {}));
    const after = history.length;
    rerender();
    rerender();
    expect(history.length).toBe(after);
  });
});

describe("copyText", () => {
  it("uses the Clipboard API when it exists", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("ssh-ed25519 AAAA")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("ssh-ed25519 AAAA");
  });

  // The actual deployment: plain HTTP over WireGuard, where navigator.clipboard
  // does not exist at all and the old code threw on every copy.
  it("falls back to execCommand on a non-secure origin", async () => {
    vi.stubGlobal("navigator", {});
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });

    await expect(copyText("fallback")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The scratch textarea must not be left in the document.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back when the Clipboard API exists but rejects", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
    await expect(copyText("x")).resolves.toBe(true);
  });

  it("reports failure rather than pretending it worked", async () => {
    vi.stubGlobal("navigator", {});
    Object.defineProperty(document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
    });
    await expect(copyText("x")).resolves.toBe(false);
  });
});
