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
  { ...member("michael", "Michael"), web: true, narrowed: ["recall"] },
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
    const { container } = render(<CouncilPanel />);
    fireEvent.click(screen.getByRole("button", { name: /add someone/ }));
    fireEvent.change(screen.getByLabelText(/their id/), { target: { value: "zadkiel" } });
    fireEvent.click(screen.getByRole("button", { name: "add" }));

    const grid = container.querySelector(".grid") as HTMLElement;
    expect(grid.children).toHaveLength(MEMBERS.length + 1);
    expect(
      within(grid.lastElementChild as HTMLElement).getAllByRole("textbox").length,
    ).toBeGreaterThan(0);
  });
});

describe("CouncilPanel (C-27)", () => {
  it("asks before removing someone, and removes nobody on the way", async () => {
    const { api } = await import("../src/api");
    const { default: CouncilPanel } = await import("../src/components/CouncilPanel");
    render(<CouncilPanel />);
    vi.mocked(api).mockClear();
    fireEvent.click(screen.getAllByRole("button", { name: "edit" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "remove" }));

    expect(await screen.findByText("Remove Uriel?")).toBeTruthy();
    expect(vi.mocked(api).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
  });

  it("refuses an id already on the bench", async () => {
    const { default: CouncilPanel } = await import("../src/components/CouncilPanel");
    render(<CouncilPanel />);
    fireEvent.click(screen.getByRole("button", { name: /add someone/ }));
    fireEvent.change(screen.getByLabelText(/their id/), { target: { value: "uriel" } });
    fireEvent.click(screen.getByRole("button", { name: "add" }));
    expect(screen.getByText("@uriel is already on the bench")).toBeTruthy();
  });
});

describe("CouncilPanel (backlog: narrowed on read)", () => {
  it("says which tools a member that reads the web does not hold", async () => {
    const { default: CouncilPanel } = await import("../src/components/CouncilPanel");
    render(<CouncilPanel />);
    expect(screen.getByText("recall not held: not beside the web")).toBeTruthy();
  });
});
