import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import ToolLog from "../src/components/settings/ToolLog";

/**
 * A-31. Every call the assistant made that changed something was logged, and
 * the only way to read it was a shell on the pod.
 */
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const entry = (tool: string, at: string, extra: object = {}) => ({
  at,
  turn: "t",
  speaker: "chair",
  unattended: false,
  tool,
  effect: "reversible",
  args: { uids: [4], to: "Arkiv" },
  ok: true,
  result: "moved 1",
  ...extra,
});

const DAYS = ["2026-09-21", "2026-09-20"];

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const day = new URL(url, "http://x").searchParams.get("day") ?? DAYS[0];
      const entries =
        day === "2026-09-21"
          ? [entry("mail_move", "2026-09-21T08:00:00Z", { unattended: true })]
          : [entry("calendar_update", "2026-09-20T08:00:00Z", { ok: false })];
      return Promise.resolve(json({ days: DAYS, day, entries }));
    }),
  );
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

describe("the tool log panel", () => {
  it("shows the newest day, and walks back to an earlier one", async () => {
    render(<ToolLog />);

    expect(await screen.findByText("mail_move")).toBeTruthy();
    expect(screen.getByText("unattended")).toBeTruthy();
    expect(screen.getByRole("button", { name: "a later day" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "an earlier day" }));

    expect(await screen.findByText("calendar_update")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "an earlier day" })).toHaveProperty("disabled", true);
  });

  it("says so when nothing has been logged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ days: [], day: null, entries: [] }))),
    );
    render(<ToolLog />);
    expect(await screen.findByText("Nothing yet.")).toBeTruthy();
  });
});
