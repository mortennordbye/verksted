import { describe, expect, it } from "vitest";
import { threadCost } from "../src/threadCost";

const total = { input: 2_000, output: 8_000, cacheRead: 400_000, cacheWrite: 2_000, turns: 9 };

describe("threadCost", () => {
  it("counts replies on a thread nobody measured", () => {
    expect(threadCost(undefined, 14)).toMatchObject({ long: false, taken: "" });
    expect(threadCost(undefined, 15).long).toBe(true);
    expect(threadCost(undefined, 15).carries).toContain("15 replies");
  });

  it("goes by the prompt once there is one, however few the replies", () => {
    const short = threadCost({ total, context: 40_000 }, 30);
    expect(short.long).toBe(false);
    expect(short.taken).toBe("412k tokens");

    const long = threadCost({ total: { ...total, costUsd: 1.5 }, context: 120_000 }, 3);
    expect(long.long).toBe(true);
    expect(long.taken).toBe("412k tokens ($1.50)");
    expect(long.carries).toContain("120k tokens");
  });
});
