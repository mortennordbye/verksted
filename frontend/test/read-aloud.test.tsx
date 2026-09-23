import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantEntry, AssistantThread } from "../../shared/api";
import { useReadAloud } from "../src/useReadAloud";

let n = 0;
const said = (text: string, extra: Partial<AssistantEntry> = {}): AssistantEntry => ({
  id: `e${++n}`,
  role: "assistant",
  text,
  tools: [],
  at: new Date().toISOString(),
  ...extra,
});
const thread = (entries: AssistantEntry[], id = "c"): AssistantThread => ({
  conversationId: id,
  status: "idle",
  entries,
});

afterEach(cleanup);

/** `speak` that finishes at once, so a batch reads through to its end. */
function setup(first: AssistantThread) {
  const speak = vi.fn((_text: string, done: () => void, _voice?: string) => done());
  const onDone = vi.fn();
  const hook = renderHook(
    ({ t }: { t: AssistantThread }) =>
      useReadAloud({ thread: t, on: true, speak, voiceOf: (e) => e.member, onDone }),
    { initialProps: { t: first } },
  );
  return { speak, onDone, ...hook };
}

describe("useReadAloud (C-38)", () => {
  it("reads nothing of a thread's history when it first comes on screen", () => {
    const { speak } = setup(thread([said("old one"), said("old two")]));
    expect(speak).not.toHaveBeenCalled();
  });

  it("reads what is said after that, in order, each in its speaker's voice", () => {
    const old = said("old");
    const { speak, onDone, rerender } = setup(thread([old]));
    rerender({ t: thread([old, said("first"), said("second", { member: "uriel" })]) });
    expect(speak.mock.calls.map((c) => [c[0], c[2]])).toEqual([
      ["first", undefined],
      ["second", "uriel"],
    ]);
    expect(onDone).toHaveBeenCalledOnce();
  });

  it("does not read an entry twice when the whole thread is sent again", () => {
    const old = said("old");
    const fresh = said("new");
    const { speak, rerender } = setup(thread([old]));
    rerender({ t: thread([old, fresh]) });
    rerender({ t: thread([old, fresh]) });
    expect(speak).toHaveBeenCalledOnce();
  });

  it("treats another thread as history too", () => {
    const { speak, rerender } = setup(thread([said("a")]));
    rerender({ t: thread([said("b"), said("c")], "other") });
    expect(speak).not.toHaveBeenCalled();
  });
});
