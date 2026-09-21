import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CouncilMember } from "../../shared/api";

const member = (id: string, name: string): CouncilMember => ({
  id,
  name,
  remit: `${name}'s remit`,
  persona: "",
  model: "sonnet",
  effort: "low",
  tools: [],
  web: false,
  colour: "sky",
  face: "robot",
  voice: "",
  chair: false,
  enabled: true,
});

const MEMBERS = [
  member("michael", "Michael"),
  member("uriel", "Uriel"),
  member("sophia", "Sophia"),
];

vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: vi.fn().mockRejectedValue(new Error("no voices")),
  usePoll: (path: string) => ({
    data: path === "/api/council" ? MEMBERS : { tools: [] },
    refresh: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("CouncilPanel (C-31)", () => {
  it("opens the form where the card was, not under the whole roster", async () => {
    const { default: CouncilPanel } = await import("../src/components/CouncilPanel");
    const { container } = render(<CouncilPanel />);
    const grid = container.querySelector(".grid") as HTMLElement;
    const cardsBefore = Array.from(grid.children).map((c) => c.textContent ?? "");
    expect(cardsBefore[1]).toContain("Uriel");

    fireEvent.click(within(grid.children[1] as HTMLElement).getByRole("button", { name: "edit" }));

    // Second in the grid still, between Michael and Sophia, and it is the form.
    const second = grid.children[1] as HTMLElement;
    expect(within(second).getByDisplayValue("Uriel")).toBeTruthy();
    expect(grid.children[0]?.textContent).toContain("Michael");
    expect(grid.children[2]?.textContent).toContain("Sophia");
    // Once: not also at the bottom, where it used to be.
    expect(screen.getAllByDisplayValue("Uriel")).toHaveLength(1);
  });

  it("opens a new member's form at the end, where their card will be", async () => {
    const { default: CouncilPanel } = await import("../src/components/CouncilPanel");
    vi.spyOn(window, "prompt").mockReturnValue("zadkiel");
    const { container } = render(<CouncilPanel />);
    fireEvent.click(screen.getByRole("button", { name: /add someone/ }));

    const grid = container.querySelector(".grid") as HTMLElement;
    expect(grid.children).toHaveLength(MEMBERS.length + 1);
    expect(
      within(grid.lastElementChild as HTMLElement).getAllByRole("textbox").length,
    ).toBeGreaterThan(0);
  });
});
