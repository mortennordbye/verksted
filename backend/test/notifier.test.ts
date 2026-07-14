import { describe, expect, it } from "vitest";
import type { Session } from "../../shared/api.js";
import { transitions } from "../src/notifier.js";

function s(id: string, status: Session["status"]): Session {
  return {
    id,
    project: "demo",
    agent: "claude",
    title: id,
    createdAt: "2026-07-14T00:00:00.000Z",
    endedAt: null,
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
