import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/api.js";
import { shouldNotify, startNotifier, transitions } from "../src/notifier.js";

// The timer case below drives startNotifier itself; the rest of the file is
// about the two pure functions and does not reach either of these.
const listSessions = vi.fn<() => Promise<Session[]>>();
vi.mock("../src/sessions-store.js", () => ({ listSessions: () => listSessions() }));
vi.mock("../src/push-store.js", () => ({
  deviceCount: async () => 1,
  send: async () => [],
}));

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
    usage: null,
    lastActivityAt: null,
    review: { reviewed: 0, verdict: null },
    unattended: null,
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

/**
 * R-10: the poll had no in-flight guard. The session list is O(history) and can
 * take longer than the five seconds between ticks, and a second pass would
 * compare against the same `prev` as the first — the same session ending twice
 * on the phone, while both passes read the whole volume.
 */
describe("the notifier's own timer", () => {
  afterEach(() => vi.useRealTimers());

  it("starts no pass while one is still running", async () => {
    vi.useFakeTimers();
    let finish: (sessions: Session[]) => void = () => {};
    listSessions.mockReturnValue(
      new Promise<Session[]>((resolve) => {
        finish = resolve;
      }),
    );
    startNotifier({ warn: vi.fn() });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(listSessions).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(listSessions).toHaveBeenCalledTimes(1);

    finish([]);
    listSessions.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(listSessions).toHaveBeenCalledTimes(2);
  });
});
