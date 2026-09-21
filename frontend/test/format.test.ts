import { describe, expect, it } from "vitest";
import { outcomeChip } from "../src/components/StatusChip";
import { bytes } from "../src/format";

/** F-47: the helpers three screens each had a copy of, now one each. */
describe("a size in bytes", () => {
  it("reads the same on every screen", () => {
    expect(bytes(812)).toBe("812 B");
    expect(bytes(4.2 * 1024 ** 2)).toBe("4.2 MB");
    expect(bytes(31 * 1024 ** 3)).toBe("31 GB");
  });
});

describe("a session's outcome as a chip", () => {
  it("is the same chip on the bench and on Today", () => {
    expect(outcomeChip("attention")).toEqual({ kind: "wait", label: "needs a look" });
    expect(outcomeChip("blocked")).toEqual({ kind: "idle", label: "blocked" });
    expect(outcomeChip("something new")).toEqual({ kind: "idle", label: "something new" });
  });
});
