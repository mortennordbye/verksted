import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/api";
import { merge } from "../src/components/ChatPane";

/**
 * How the session chat takes a poll's answer.
 *
 * Not append-only, which is what it used to be. The server does not only add
 * messages, it changes ones it has already sent: a question card is written
 * when the question is put and mutated when the answer arrives.
 */
const said = (id: string, text: string, at = "2026-01-01T00:00:00.000Z"): ChatMessage => ({
  id,
  role: "assistant",
  text,
  tools: [],
  at,
});

const asking = (answered: boolean, chosen: string[] = []): ChatMessage => ({
  id: "a1:ask",
  role: "assistant",
  text: "",
  tools: [],
  at: "2026-01-01T00:00:01.000Z",
  ask: {
    id: "q1",
    answered,
    questions: [
      {
        header: "Scope",
        question: "Which scope?",
        multiSelect: false,
        options: [{ label: "Both repos", description: "the full fix" }],
        chosen,
      },
    ],
  },
});

describe("merge", () => {
  it("adds what it has not seen, in order", () => {
    const out = merge([said("a", "first")], [said("a", "first"), said("b", "second")]);
    expect(out.map((m) => m.text)).toEqual(["first", "second"]);
  });

  /**
   * The bug this pins: an answered question stayed on screen asking, with its
   * buttons live, for the rest of the session — the client held the card by id
   * and every later poll carrying it was discarded as already seen.
   */
  it("replaces a card that has closed since it was first drawn", () => {
    const open = merge([], [said("a", "hello"), asking(false)]);
    expect(open.at(-1)!.ask!.answered).toBe(false);

    const closed = merge(open, [asking(true, ["Both repos"])]);

    expect(closed).toHaveLength(2);
    expect(closed.at(-1)!.ask!.answered).toBe(true);
    expect(closed.at(-1)!.ask!.questions[0].chosen).toEqual(["Both repos"]);
    // In its own place, not appended to the end.
    expect(closed.map((m) => m.id)).toEqual(["a", "a1:ask"]);
  });

  it("keeps a multi-question card up to date as it is answered one at a time", () => {
    const open = merge([], [asking(false)]);
    const partly = merge(open, [asking(false, ["Both repos"])]);
    expect(partly.at(-1)!.ask!.questions[0].chosen).toEqual(["Both repos"]);
  });

  /**
   * What makes the replacement affordable. The newest turn is re-sent on every
   * poll by design, and every bubble re-parses its markdown when its object
   * changes — so a poll that carries nothing new must change nothing at all.
   */
  it("returns the very same array and the very same objects when nothing moved", () => {
    const held = merge([], [said("a", "first"), asking(false)]);

    const again = merge(held, [said("a", "first"), asking(false)]);

    expect(again).toBe(held);
    expect(again[0]).toBe(held[0]);
  });

  /**
   * "Load earlier" asks for a wider window, and what comes back is the whole
   * of it: the same turns plus the ones before them. Appending by unseen id
   * put that older half at the *bottom* of the conversation, which is why the
   * view used to be blanked to skeletons and rebuilt instead.
   */
  it("puts a widened window's older turns above what was already held", () => {
    const held = merge([], [said("c", "third"), said("d", "fourth")]);

    const wider = merge(
      held,
      [said("a", "first"), said("b", "second"), said("c", "third"), said("d", "fourth")],
      true,
    );

    expect(wider.map((m) => m.text)).toEqual(["first", "second", "third", "fourth"]);
    // The turns already on screen are the same objects, so only the new ones
    // are drawn: a wider window must not re-parse the whole conversation.
    expect(wider[2]).toBe(held[0]);
    expect(wider[3]).toBe(held[1]);
  });

  it("returns the same array when a whole window says exactly what was held", () => {
    const held = merge([], [said("a", "first"), said("b", "second")]);
    expect(merge(held, [said("a", "first"), said("b", "second")], true)).toBe(held);
  });

  it("notices a turn that has grown another tool chip", () => {
    const held = merge([], [said("a", "working")]);
    const grown: ChatMessage = {
      ...said("a", "working"),
      tools: [{ id: "t1", name: "Bash", detail: "git status" }],
    };

    const out = merge(held, [grown]);

    expect(out).not.toBe(held);
    expect(out[0].tools).toHaveLength(1);
  });
});
