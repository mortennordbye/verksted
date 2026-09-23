import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../../shared/api";

const memory: Memory = {
  slug: "tabs",
  text: "Uses tabs, never spaces.",
  type: "preference",
  scope: "global",
} as Memory;

let profileFresh = true;
const api = vi.fn();
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: (...args: unknown[]) => api(...args),
  usePoll: (path: string) => ({
    data:
      path === "/api/memory"
        ? { memories: [memory], used: 10, budget: 100, dropped: 0 }
        : path === "/api/profile"
          ? { text: "Lives in Oslo.\n", used: 15, budget: 8192 }
          : [],
    fresh: path === "/api/profile" ? profileFresh : true,
    refresh: vi.fn(),
  }),
}));

beforeEach(() => {
  profileFresh = true;
  api.mockReset();
  api.mockResolvedValue({});
});

afterEach(cleanup);

describe("MemoryPanel (C-27)", () => {
  it("asks before forgetting, and says so when the forget failed", async () => {
    const { default: MemoryPanel } = await import("../src/components/MemoryPanel");
    render(<MemoryPanel />);
    fireEvent.click(screen.getByRole("button", { name: /forget: Uses tabs/ }));
    expect(api).not.toHaveBeenCalled();

    api.mockRejectedValueOnce(new Error("the volume is read-only"));
    fireEvent.click(await screen.findByRole("button", { name: "forget" }));
    expect(await screen.findByText("the volume is read-only")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/api/memory/tabs", { method: "DELETE" });
  });
});

describe("ProfilePanel (C-11)", () => {
  it("cannot be edited from last visit's cached text", async () => {
    profileFresh = false;
    const { default: ProfilePanel } = await import("../src/components/ProfilePanel");
    render(<ProfilePanel />);
    expect(screen.queryByLabelText("profile")).toBeNull();
  });

  it("names the text the edit started from, so a line added since is not saved over", async () => {
    const { default: ProfilePanel } = await import("../src/components/ProfilePanel");
    render(<ProfilePanel />);
    fireEvent.change(screen.getByLabelText("profile"), {
      target: { value: "Lives in Bergen.\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(api).toHaveBeenCalledWith("/api/profile", {
      method: "PUT",
      body: JSON.stringify({ text: "Lives in Bergen.\n", base: "Lives in Oslo.\n" }),
    });
  });
});
