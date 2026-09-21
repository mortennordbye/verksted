import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Hear it" on the settings page (C-35). What is pinned is that the clip's
 * object URL is given back on every way out, which the two copies of this that
 * the panels had did only when the clip played to its end.
 */
let refuse = false;
let created: string[];
let revoked: string[];
let listeners: Map<string, Set<() => void>>;

beforeEach(() => {
  refuse = false;
  created = [];
  revoked = [];
  listeners = new Map();
  vi.resetModules();
  vi.stubGlobal(
    "Audio",
    class {
      src = "";
      addEventListener(type: string, fn: () => void) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(fn);
      }
      removeEventListener(type: string, fn: () => void) {
        listeners.get(type)?.delete(fn);
      }
      play() {
        return refuse ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve();
      }
    },
  );
  // Assigned, not stubbed whole: `URL` is also a constructor other code needs,
  // and jsdom has neither of these two statics to spy on.
  URL.createObjectURL = () => {
    const url = `blob:clip-${created.length + 1}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response(new Blob(["wav"]), { status: 200 }))),
  );
});

const fire = (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn());

describe("playSample", () => {
  it("gives the clip back when it has played", async () => {
    const { playSample } = await import("../src/useSpeech");
    expect(await playSample("Nothing needs you.", "af_sarah")).toBe(true);
    expect(revoked).toEqual([]);

    fire("ended");
    expect(revoked).toEqual(["blob:clip-1"]);
    expect(listeners.get("ended")?.size).toBe(0);
  });

  it("gives it back when the browser will not play it", async () => {
    refuse = true;
    const { playSample } = await import("../src/useSpeech");
    expect(await playSample("Nothing needs you.")).toBe(false);
    expect(revoked).toEqual(["blob:clip-1"]);
  });

  it("gives the first back when a second is asked for before it ended", async () => {
    const { playSample } = await import("../src/useSpeech");
    await playSample("one");
    await playSample("two");
    expect(revoked).toEqual(["blob:clip-1"]);

    fire("ended");
    expect(revoked).toEqual(["blob:clip-1", "blob:clip-2"]);
  });

  it("says no, and makes no clip, when the pod has no voice", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("", { status: 503 }))),
    );
    const { playSample } = await import("../src/useSpeech");
    expect(await playSample("one")).toBe(false);
    expect(created).toEqual([]);
  });
});
