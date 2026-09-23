import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantThreadSummary } from "../../shared/api";

const api = vi.fn();
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: (...args: unknown[]) => api(...args),
}));

const { default: Threads } = await import("../src/components/assistant/Threads");

const t = (id: string, title: string, extra: Partial<AssistantThreadSummary> = {}) => ({
  conversationId: id,
  title,
  at: new Date().toISOString(),
  turns: 1,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  api.mockReset();
  api.mockImplementation((url: string) =>
    Promise.resolve(
      url.includes("?q=")
        ? [t("b", "Cluster", { match: "…the Kargo promotion…" })]
        : [t("a", "Rent"), t("b", "Cluster")],
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function show() {
  render(<Threads current="a" onOpen={() => {}} onNew={() => {}} onClose={() => {}} />);
  return act(() => vi.advanceTimersByTimeAsync(0));
}

describe("Threads (C-30)", () => {
  it("searches what was said, once typing pauses, and shows where", async () => {
    await show();
    fireEvent.change(screen.getByLabelText("search the threads"), { target: { value: "kargo" } });
    fireEvent.change(screen.getByLabelText("search the threads"), {
      target: { value: "kargo promotion" },
    });
    await act(() => vi.advanceTimersByTimeAsync(300));
    const searches = api.mock.calls.filter(([url]) => String(url).includes("?q="));
    expect(searches.map(([url]) => url)).toEqual(["/api/assistant/threads?q=kargo%20promotion"]);
    expect(screen.getByText("…the Kargo promotion…")).toBeTruthy();
    // Clearing old threads is for the whole list, not what a search found.
    expect(screen.queryByRole("button", { name: /clear old threads/ })).toBeNull();
  });

  it("renames a thread in place", async () => {
    await show();
    fireEvent.click(screen.getByRole("button", { name: 'rename the thread "Cluster"' }));
    fireEvent.change(screen.getByLabelText("the thread's name"), {
      target: { value: "Cluster upgrade" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api).toHaveBeenCalledWith("/api/assistant/threads/b/title", {
      method: "PUT",
      body: JSON.stringify({ title: "Cluster upgrade" }),
    });
  });

  it("offers each thread as a markdown download", async () => {
    await show();
    const link = screen.getByRole("link", { name: /download the thread "Rent"/ });
    expect(link.getAttribute("href")).toBe("/api/assistant/threads/a/export");
    expect(link.hasAttribute("download")).toBe(true);
  });
});
