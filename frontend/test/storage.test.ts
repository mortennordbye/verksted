import { afterEach, describe, expect, it, vi } from "vitest";
import { readStored, readStoredNumber, removeStored, writeStored } from "../src/storage";

/**
 * F-11. Half of these reads happen during render — the terminal's font size,
 * the session's split ratio, the hub's density — and `localStorage` is not a
 * plain object everywhere this app is opened: Safari with cookies blocked, a
 * private window and a full quota all throw on the accessor itself. The screen
 * went with the preference.
 */
const blocked = () =>
  vi.stubGlobal("localStorage", {
    get getItem(): never {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    get setItem(): never {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
    get removeItem(): never {
      throw new DOMException("The operation is insecure.", "SecurityError");
    },
  });

afterEach(() => vi.unstubAllGlobals());

describe("storage that cannot be reached", () => {
  it("reads as nothing stored rather than throwing", () => {
    blocked();
    expect(readStored("vk.term.fontSize")).toBeNull();
    expect(readStoredNumber("vk.term.fontSize", 13, 8, 22)).toBe(13);
  });

  it("swallows the write and the removal", () => {
    blocked();
    expect(() => writeStored("vk.hub.compact", "1")).not.toThrow();
    expect(() => removeStored("vk.hub.compact")).not.toThrow();
  });
});

describe("a stored number", () => {
  it("is the fallback unless it is a number inside the range", () => {
    writeStored("n", "300");
    expect(readStoredNumber("n", 250, 160, 640)).toBe(300);
    // What is in storage is user-editable text, and both of these used to reach
    // an xterm font size and a flex-basis.
    writeStored("n", "9000");
    expect(readStoredNumber("n", 250, 160, 640)).toBe(250);
    writeStored("n", "wide");
    expect(readStoredNumber("n", 250, 160, 640)).toBe(250);
    removeStored("n");
    expect(readStoredNumber("n", 250, 160, 640)).toBe(250);
  });
});
