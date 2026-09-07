import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CouncilMember } from "../../shared/api";
import CouncilPanel from "../src/components/CouncilPanel";

/**
 * The one thing this panel says that nothing else can.
 *
 * A member-only tool is one the chair is never offered, so if no advisor holds
 * it the feature behind it is unreachable and nothing anywhere says so — which
 * is how the documents stayed dark on this bench from the day they shipped.
 */
const INVENTORY = {
  tools: [
    { name: "status", chairOnly: false },
    { name: "recall", chairOnly: false },
    { name: "mail_read", chairOnly: false, memberOnly: true },
    { name: "docs_search", chairOnly: false, memberOnly: true },
    { name: "merge_pr", chairOnly: true },
  ],
};

const member = (over: Partial<CouncilMember> = {}): CouncilMember => ({
  id: "uriel",
  name: "Uriel",
  remit: "the mail and the documents",
  persona: "",
  model: "sonnet",
  effort: "low",
  tools: ["status", "recall"],
  web: false,
  colour: "amber",
  face: "cat",
  voice: "",
  chair: false,
  enabled: true,
  ...over,
});

let fetchMock: ReturnType<typeof vi.fn>;

/** Routed by path: the panel asks for the roster, the inventory and the voices. */
const answer = (members: CouncilMember[]) =>
  fetchMock.mockImplementation((url: string) => {
    const body = url.startsWith("/api/council/tools")
      ? INVENTORY
      : url.startsWith("/api/council")
        ? members
        : { voices: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CouncilPanel", () => {
  it("names the member-only tools no advisor holds", async () => {
    answer([member()]);
    render(<CouncilPanel />);

    const warning = await screen.findByText(/Nobody holds/);
    expect(warning.textContent).toContain("mail_read");
    expect(warning.textContent).toContain("docs_search");
    // The chair holds every other tool by definition, so those are never here.
    expect(warning.textContent).not.toContain("status");
    expect(warning.textContent).not.toContain("merge_pr");
  });

  it("says nothing once an advisor holds them", async () => {
    answer([member({ tools: ["status", "mail_read", "docs_search"] })]);
    render(<CouncilPanel />);

    expect(await screen.findByText("Uriel")).toBeDefined();
    expect(screen.queryByText(/Nobody holds/)).toBeNull();
  });

  it("does not count a paused advisor, which is asked nothing", async () => {
    answer([member({ tools: ["mail_read", "docs_search"], enabled: false })]);
    render(<CouncilPanel />);

    const warning = await screen.findByText(/Nobody holds/);
    expect(warning.textContent).toContain("mail_read");
  });
});
