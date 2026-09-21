import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FeedItem, ProposalAction } from "../../shared/api";
import ProposalCard from "../src/components/ProposalCard";

/**
 * The cards for what has no way back (A-08, A-09). The tap is the
 * authorisation, so what is pinned is that the thing being authorised is on
 * the card: the filter, the event, the subjects, and what the button will do.
 */
afterEach(cleanup);

const card = (action: ProposalAction) => {
  const item: FeedItem = {
    id: "proposal:1",
    source: "proposal",
    at: "2026-09-21T10:00:00Z",
    title: "a card",
    detail: "you asked\n\nthe rest",
    link: "/runs#proposal:1",
    version: "proposed",
    urgency: "attention",
    state: "new",
    pushed: true,
    action,
  } as FeedItem;
  render(<ProposalCard item={item} onChange={() => {}} />);
};

describe("a card for something with no way back", () => {
  it("shows the filter that would go", () => {
    card({
      kind: "mail_rule_delete",
      id: "F1",
      rule: { id: "F1", from: "bank@example.com", label: "Bank", archive: true, markRead: false },
    });
    expect(screen.getByText("from bank@example.com")).toBeTruthy();
    expect(screen.getByText("label Bank, archive")).toBeTruthy();
    expect(screen.getByRole("button", { name: "remove it" })).toBeTruthy();
  });

  it("shows the event, and whether it is the one or all of them", () => {
    card({
      kind: "calendar_delete",
      uid: "standup@x",
      every: true,
      event: {
        summary: "Standup",
        start: "2026-09-22T10:00:00Z",
        end: "2026-09-22T10:15:00Z",
        location: null,
      },
    });
    expect(screen.getByText("Standup")).toBeTruthy();
    expect(screen.getByText("every occurrence of the series")).toBeTruthy();
    expect(screen.getByRole("button", { name: "take it off" })).toBeTruthy();
  });

  it("shows the subjects a move into the junk folder would take", () => {
    card({
      kind: "mail_move",
      uids: [7],
      to: "[Gmail]/Spam",
      subjects: ["Lottery: You won"],
    });
    expect(screen.getByText("Lottery: You won")).toBeTruthy();
    expect(screen.getByText("[Gmail]/Spam")).toBeTruthy();
    expect(screen.getByRole("button", { name: "move them" })).toBeTruthy();
  });
});
