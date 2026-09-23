import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanePrompt } from "../src/usePanePrompt";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify({ prompt: null, mode: "plan", busy: true, doing: "Reading" }), {
        headers: { "content-type": "application/json" },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("usePanePrompt", () => {
  it("reads the pane while the session is live, and forgets it once it is not", async () => {
    const { result, rerender } = renderHook(({ live }) => usePanePrompt("vk-demo-1", live), {
      initialProps: { live: true },
    });
    await waitFor(() => expect(result.current.mode).toBe("plan"));
    expect(result.current.busy).toBe(true);
    expect(result.current.doing).toBe("Reading");

    rerender({ live: false });
    expect(result.current.mode).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.doing).toBeNull();
  });

  it("does not read a pane that is not live", () => {
    renderHook(() => usePanePrompt("vk-demo-1", false));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
