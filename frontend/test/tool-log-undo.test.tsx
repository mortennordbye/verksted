import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolLogDay, ToolLogEntry } from "../../shared/api";

const entry = (tool: string, at: string, undo?: ToolLogEntry["undo"]): ToolLogEntry => ({
  at,
  turn: "t",
  speaker: "Gabriel",
  unattended: false,
  tool,
  effect: "reversible",
  args: {},
  ok: true,
  result: "",
  ...(undo ? { undo } : {}),
});

const DAY: ToolLogDay = {
  days: ["2026-09-20"],
  day: "2026-09-20",
  entries: [
    entry("mail_move", "2026-09-20T10:00:00.000Z", "can"),
    entry("mail_relabel", "2026-09-20T11:00:00.000Z", "done"),
    entry("remember", "2026-09-20T12:00:00.000Z"),
  ],
};

const api = vi.fn().mockResolvedValue({ said: "2 messages moved back to INBOX" });
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: (...args: unknown[]) => api(...args),
  usePoll: () => ({ data: DAY, error: null, refresh: vi.fn() }),
}));

const { default: ToolLog } = await import("../src/components/settings/ToolLog");

afterEach(cleanup);

describe("ToolLog (backlog: undo)", () => {
  it("offers to put back only what can be, and asks first", async () => {
    render(<ToolLog />);
    expect(screen.getAllByRole("button", { name: "put back" })).toHaveLength(1);
    expect(screen.getByText("put back", { selector: "span" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "put back" }));
    expect(api).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        [...dialog.querySelectorAll("button")].find((b) => b.textContent === "put back")!,
      );
    });
    await vi.waitFor(() =>
      expect(api).toHaveBeenCalledWith("/api/assistant/tool-log/undo", {
        method: "POST",
        body: JSON.stringify({ day: "2026-09-20", at: "2026-09-20T10:00:00.000Z" }),
      }),
    );
  });
});
