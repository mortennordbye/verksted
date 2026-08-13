import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/api.js";
import { shouldNotify, transitions } from "../src/notifier.js";

function s(id: string, status: Session["status"]): Session {
  return {
    id,
    project: "demo",
    agent: "claude",
    title: id,
    createdAt: "2026-07-14T00:00:00.000Z",
    endedAt: null,
    report: null,
    outcome: "running" as const,
    work: null,
    idleSeconds: null,
    review: { reviewed: 0, verdict: null },
    status,
  };
}

const prev = (entries: [string, Session["status"]][]) => new Map(entries);

describe("notifier transitions", () => {
  it("notifies when a running session starts waiting", () => {
    const out = transitions(prev([["a", "running"]]), [s("a", "waiting")]);
    expect(out.map((x) => x.id)).toEqual(["a"]);
  });

  it("notifies when a session ends, from running or waiting", () => {
    const out = transitions(
      prev([
        ["a", "running"],
        ["b", "waiting"],
      ]),
      [s("a", "done"), s("b", "done")],
    );
    expect(out.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("keeps a run that reported itself clean off the phone", () => {
    expect(shouldNotify(s("a", "done"), "ok: nothing to merge")).toBe(false);
    expect(shouldNotify(s("a", "done"), "OK: all green")).toBe(false);
  });

  it("pushes a run that wants something, and one that says nothing at all", () => {
    expect(shouldNotify(s("a", "done"), "attention: #14 needs a review")).toBe(true);
    expect(shouldNotify(s("a", "done"), "failed: gh auth expired")).toBe(true);
    // No report is a hand-started session: it announces that it finished, as before.
    expect(shouldNotify(s("a", "done"), null)).toBe(true);
    // "okay"/"okra" are not the keyword — only the bare word counts.
    expect(shouldNotify(s("a", "done"), "okay-ish: two PRs left")).toBe(true);
  });

  it("always pushes a session that stopped to ask, whatever it reported", () => {
    expect(shouldNotify(s("a", "waiting"), "ok: nothing to merge")).toBe(true);
  });

  it("stays quiet on unchanged status, back-to-running, and unseen sessions", () => {
    const out = transitions(
      prev([
        ["a", "waiting"],
        ["b", "done"],
      ]),
      [s("a", "running"), s("b", "done"), s("new", "waiting")],
    );
    expect(out).toEqual([]);
  });
});
