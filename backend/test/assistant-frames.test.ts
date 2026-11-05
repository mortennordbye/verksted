import { describe, expect, it } from "vitest";
import type { AssistantEntry, AssistantThread } from "../../shared/api.js";
import { frameFor, freshSent } from "../src/assistant-frames.js";

const entry = (id: string): AssistantEntry => ({
  id,
  at: "2026-11-05T10:00:00Z",
  role: "assistant",
  text: id,
  tools: [],
});

const thread = (entries: AssistantEntry[], live?: string) =>
  ({
    conversationId: "c",
    status: "thinking",
    entries,
    ...(live ? { live } : {}),
  }) as AssistantThread;

describe("the smallest frame that brings a socket up to date", () => {
  it("sends the whole thread first", () => {
    const entries = [entry("a")];

    expect(frameFor(thread(entries), freshSent()).entries).toBe(entries);
  });

  it("sends no entries when nothing was said", () => {
    const sent = freshSent();
    const entries = [entry("a")];
    frameFor(thread(entries), sent);

    const frame = frameFor(thread(entries), sent);

    expect(frame.entries).toBeUndefined();
    expect(frame.appended).toBeUndefined();
  });

  it("sends only what was added to the end", () => {
    const sent = freshSent();
    const first = [entry("a")];
    frameFor(thread(first), sent);

    const frame = frameFor(thread([...first, entry("b")]), sent);

    expect(frame.entries).toBeUndefined();
    expect(frame.after).toBe(1);
    expect(frame.appended?.map((e) => e.id)).toEqual(["b"]);
  });

  it("sends a different thread whole, not as an append", () => {
    const sent = freshSent();
    frameFor(thread([entry("a")]), sent);
    const other = [entry("x"), entry("y")];

    const frame = frameFor(thread(other), sent);

    expect(frame.entries).toBe(other);
    expect(frame.appended).toBeUndefined();
  });

  it("sends a shorter thread whole", () => {
    const sent = freshSent();
    frameFor(thread([entry("a"), entry("b")]), sent);

    expect(frameFor(thread([entry("a")]), sent).entries).toHaveLength(1);
  });

  it("sends only the new words of a reply, so bytes do not grow with its length", () => {
    const sent = freshSent();
    const entries = [entry("a")];
    expect(frameFor(thread(entries, "Hello"), sent).live).toBe("Hello");

    const frame = frameFor(thread(entries, "Hello world"), sent);

    expect(frame.live).toBeUndefined();
    expect(frame.liveFrom).toBe(5);
    expect(frame.liveDelta).toBe(" world");
  });

  it("starts the text over when a new reply begins", () => {
    const sent = freshSent();
    const entries = [entry("a")];
    frameFor(thread(entries, "First reply"), sent);
    frameFor(thread(entries), sent);

    expect(frameFor(thread(entries, "Second"), sent).live).toBe("Second");
  });
});
