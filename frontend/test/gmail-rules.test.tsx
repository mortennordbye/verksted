import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FeedItem, GmailRule } from "../../shared/api";

const RULES: GmailRule[] = [
  { id: "r1", from: "news@shop.example", label: "Shopping", archive: true, markRead: false },
];

const card = {
  id: "proposal:1",
  source: "proposal",
  at: "2026-09-20T10:00:00.000Z",
  title: "Remove the Gmail filter from news@shop.example",
  detail: "its definition goes with it",
  link: "/runs#proposal:1",
  version: "proposed",
  urgency: "attention",
  state: "new",
  action: { kind: "mail_rule_delete", id: "r1", rule: RULES[0] },
} as unknown as FeedItem;

const api = vi.fn().mockResolvedValue(card);
vi.mock("../src/api", async (orig) => ({
  ...(await orig<typeof import("../src/api")>()),
  api: (...args: unknown[]) => api(...args),
  usePoll: () => ({ data: RULES, error: null, refresh: vi.fn() }),
}));

const { default: GmailRules } = await import("../src/components/settings/GmailRules");

afterEach(cleanup);

describe("GmailRules (backlog)", () => {
  it("lists the filters, and removing one files a quiet card to tap", async () => {
    render(<GmailRules />);
    expect(screen.getByText(/news@shop\.example → label Shopping, skip the inbox/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "remove" }));
    });
    expect(api).toHaveBeenCalledWith("/api/proposals", {
      method: "POST",
      body: JSON.stringify({ action: { kind: "mail_rule_delete", id: "r1" }, quiet: true }),
    });
    // Nothing removed yet: the card is what does it, on a tap.
    expect(api).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /remove it/ })).toBeTruthy();
  });
});
