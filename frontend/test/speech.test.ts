import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chunkForSpeech, sortVoices, useSpeech, voiceLabel } from "../src/useSpeech";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("chunkForSpeech", () => {
  // The reason chunks exist: the first sentence is spoken while the rest is
  // still being made, so the wait before any sound is one sentence long.
  it("splits a reply into sentences", () => {
    expect(
      chunkForSpeech(
        "The nightly run signed off ok. Three commits landed on main, and nothing needs you. " +
          "The pull request for the scheduler fix is still waiting for a review from someone.",
      ),
    ).toEqual([
      "The nightly run signed off ok. Three commits landed on main, and nothing needs you.",
      "The pull request for the scheduler fix is still waiting for a review from someone.",
    ]);
  });

  // A round trip to say one word is a round trip wasted.
  it("merges short sentences rather than making a request per word", () => {
    expect(chunkForSpeech("Done. All good. Nothing needs you.")).toEqual([
      "Done. All good. Nothing needs you.",
    ]);
  });

  it("splits a sentence longer than the endpoint accepts, on a space", () => {
    const chunks = chunkForSpeech(("word ".repeat(400) + "end.").trim());
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(800);
    expect(chunks.join(" ").replace(/\s+/g, " ")).toContain("word word");
  });

  it("has nothing to say about nothing", () => {
    expect(chunkForSpeech("")).toEqual([]);
    expect(chunkForSpeech("   ")).toEqual([]);
  });
});

describe("voiceLabel", () => {
  it("spells out what the model's names encode", () => {
    expect(voiceLabel("bf_emma")).toBe("Emma · British female");
    expect(voiceLabel("am_michael")).toBe("Michael · American male");
  });

  it("leaves a name it does not recognise alone", () => {
    expect(voiceLabel("Samantha")).toBe("Samantha");
  });

  it("puts the English voices first, since that is what it answers in", () => {
    expect(sortVoices(["zf_xiaoni", "bf_emma", "jm_kumo", "af_heart"])).toEqual([
      "af_heart",
      "bf_emma",
      "jm_kumo",
      "zf_xiaoni",
    ]);
  });
});

/** The silent clip speak() primes the player with; see unlockAudio. */
const PRIMING = /^data:audio\/wav/;

describe("useSpeech.speak", () => {
  let played: string[];
  let spoken: string[];
  let calls: string[];

  beforeEach(() => {
    played = [];
    spoken = [];
    calls = [];
    // jsdom has neither, and both are the two ways this can make a sound.
    vi.stubGlobal(
      "Audio",
      class {
        src = "";
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        pause() {
          calls.push("pause");
        }
        play() {
          played.push(this.src);
          calls.push("play");
          setTimeout(() => this.onended?.(), 0);
          return Promise.resolve();
        }
      },
    );
    vi.stubGlobal("speechSynthesis", {
      cancel: () => {},
      getVoices: () => [],
      speak: (u: { text: string; onend?: () => void }) => {
        spoken.push(u.text);
        u.onend?.();
      },
    });
    vi.stubGlobal(
      "SpeechSynthesisUtterance",
      class {
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(public text: string) {}
      },
    );
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:clip", revokeObjectURL: () => {} });
  });

  it("says it in the pod's voice, one chunk per request", async () => {
    // A fresh Response per call: a body can only be read once, and reusing one
    // makes the second chunk look like a pod with no voice.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(new Blob([new Uint8Array([1])]))));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSpeech(() => {}));

    const done = vi.fn();
    await act(async () => {
      result.current.speak("First sentence here. " + "x".repeat(200) + ".", done);
    });

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      "/api/assistant/speak",
      "/api/assistant/speak",
    ]);
    // The silent clip first: that is the play() inside the tap which unlocks
    // the element. The chunks arrive from the pod long after the tap is over,
    // and without it iOS refuses to play them.
    expect(played[0]).toMatch(PRIMING);
    expect(played.slice(1)).toEqual(["blob:clip", "blob:clip"]);
    // The browser voice was never reached.
    expect(spoken).toEqual([]);
  });

  // The bug this guards: speak() paused the player it had just primed, which
  // aborts the unlocking play() and leaves the element locked. On the phone
  // that was the read-aloud button making no sound at all.
  it("never pauses the player it has just primed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response(new Blob([new Uint8Array([1])])))),
    );
    const { result } = renderHook(() => useSpeech(() => {}));

    const done = vi.fn();
    await act(async () => {
      result.current.speak("Nothing needs you.", done);
    });

    await waitFor(() => expect(done).toHaveBeenCalled());
    expect(calls).toEqual(["play", "play"]);
  });

  // A pod without the model answers 503, and voice mode has to keep working —
  // badly, in the browser's own voice, rather than not at all.
  it("falls back to the browser when the pod has no voice", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(new Response(JSON.stringify({ error: "no voice" }), { status: 503 })),
        ),
    );
    const { result } = renderHook(() => useSpeech(() => {}));

    const done = vi.fn();
    await act(async () => {
      result.current.speak("Nothing needs you.", done);
    });

    await waitFor(() => expect(spoken).toEqual(["Nothing needs you."]));
    // Only the priming clip: the pod had nothing to send, so nothing was played.
    expect(played).toHaveLength(1);
    expect(played[0]).toMatch(PRIMING);
    expect(done).toHaveBeenCalled();
  });

  it("falls back when the pod cannot be reached at all", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const { result } = renderHook(() => useSpeech(() => {}));
    await act(async () => {
      result.current.speak("Still say it.");
    });
    await waitFor(() => expect(spoken).toEqual(["Still say it."]));
  });
});
