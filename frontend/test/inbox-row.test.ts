import { describe, expect, it } from "vitest";
import type { FeedItem } from "../../shared/api";
import { saysTheSame } from "../src/screens/Inbox";

/**
 * The row draws a detail line and a facts line, and for a while the pollers
 * wrote both from the same words. New items no longer carry the pair, but an
 * item is only rewritten when its version moves on, so the ones filed in
 * between keep it — and one of the three on the pod was already triaged, so
 * waiting for triage to replace it would not have worked either.
 */
const item = (detail: string, facts: string[]): FeedItem => ({ detail, facts }) as FeedItem;

describe("saysTheSame", () => {
  it("catches a detail that is the facts in a sentence", () => {
    // Exactly the three shapes found on the pod.
    expect(
      saysTheSame(
        item("PullRequest, on something you watch", ["PullRequest", "on something you watch"]),
      ),
    ).toBe(true);
    expect(saysTheSame(item("PullRequest, state changed", ["PullRequest", "state changed"]))).toBe(
      true,
    );
  });

  it("keeps a detail that says something the facts do not", () => {
    expect(
      saysTheSame(
        item("reelsmith ponytail render is stranded", ["attention", "reelsmith", "38k tokens"]),
      ),
    ).toBe(false);
    // Triage's own summary, which reads close to the facts but is not them.
    expect(
      saysTheSame(item("CI workflow run failed on main branch", ["CheckSuite", "a workflow run"])),
    ).toBe(false);
  });

  it("catches a detail that is one of the facts", () => {
    // What a backfilled mail row became: the old detail was the sender's
    // address, and the facts are that address plus the word unread, so the
    // two never match whole and the row drew the address twice.
    expect(saysTheSame(item("info@tailscale.com", ["info@tailscale.com", "unread"]))).toBe(true);
    expect(
      saysTheSame(item("service@service.ryanairemail.com", ["service@service.ryanairemail.com"])),
    ).toBe(true);
  });

  it("has nothing to compare when there are no facts", () => {
    expect(saysTheSame(item("anything at all", []))).toBe(false);
    expect(saysTheSame(item("", ["a fact"]))).toBe(false);
  });
});
