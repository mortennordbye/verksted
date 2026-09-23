import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Dock from "../src/components/assistant/Dock";
import { useDraft } from "../src/useDraft";

// A phone: the panel is the whole screen.
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe("Dock (C-17)", () => {
  it("is a dialog, and takes the focus", () => {
    render(
      <Dock title="Calendar" sub="" onClose={() => {}}>
        <p>month</p>
      </Dock>,
    );
    const dialog = screen.getByRole("dialog", { name: "Calendar" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape only where it is told to", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Dock title="Browser" sub="" onClose={onClose}>
        <p />
      </Dock>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    rerender(
      <Dock title="Browser" sub="" onClose={onClose} escape>
        <p />
      </Dock>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on Back rather than leaving the screen", async () => {
    const onClose = vi.fn();
    render(
      <Dock title="Calendar" sub="" onClose={onClose}>
        <p />
      </Dock>,
    );
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: null })));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("useDraft (C-21)", () => {
  it("gives a half-written message back after the screen is gone", () => {
    const first = renderHook(() => useDraft("vk.draft.x"));
    act(() => first.result.current[1]("half a tho"));
    first.unmount();
    const again = renderHook(() => useDraft("vk.draft.x"));
    expect(again.result.current[0]).toBe("half a tho");
  });

  it("keeps each key's draft apart, and forgets one that was sent", () => {
    const { result, rerender } = renderHook(({ k }) => useDraft(k), {
      initialProps: { k: "vk.draft.a" },
    });
    act(() => result.current[1]("for a"));
    rerender({ k: "vk.draft.b" });
    expect(result.current[0]).toBe("");
    rerender({ k: "vk.draft.a" });
    expect(result.current[0]).toBe("for a");
    act(() => result.current[1](""));
    expect(sessionStorage.getItem("vk.draft.a")).toBeNull();
  });
});
