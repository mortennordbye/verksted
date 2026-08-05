import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ReplaceTimeout, runReplace } from "../src/replace.js";

let dir: string;
const file = (name: string, body: string) => {
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, body);
  return abs;
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-replace-"));
});

describe("runReplace", () => {
  it("rewrites every occurrence and reports the counts", async () => {
    const a = file("a.txt", "foo bar foo");
    const b = file("b.txt", "foo");
    const result = await runReplace({
      paths: [a, b],
      source: "foo",
      flags: "g",
      replacement: "baz",
      literal: true,
    });
    expect(result).toEqual({ files: 2, replacements: 3 });
    expect(fs.readFileSync(a, "utf8")).toBe("baz bar baz");
  });

  it("keeps $-syntax literal for a plain-text search", async () => {
    const a = file("dollar.txt", "price");
    await runReplace({
      paths: [a],
      source: "price",
      flags: "g",
      replacement: "$& $1",
      literal: true,
    });
    expect(fs.readFileSync(a, "utf8")).toBe("$& $1");
  });

  it("honours backreferences for a regex search", async () => {
    const a = file("re.txt", "aXb");
    const result = await runReplace({
      paths: [a],
      source: "a(X)b",
      flags: "g",
      replacement: "[$1]",
      literal: false,
    });
    expect(fs.readFileSync(a, "utf8")).toBe("[X]");
    expect(result).toEqual({ files: 1, replacements: 1 });
  });

  it("counts nothing and writes nothing when a listed file no longer matches", async () => {
    const a = file("stale.txt", "nothing here");
    expect(
      await runReplace({ paths: [a], source: "zzz", flags: "g", replacement: "x", literal: true }),
    ).toEqual({ files: 0, replacements: 0 });
  });

  it("skips a file deleted under it rather than failing the whole run", async () => {
    const gone = path.join(dir, "gone.txt");
    const kept = file("kept.txt", "foo");
    expect(
      await runReplace({
        paths: [gone, kept],
        source: "foo",
        flags: "g",
        replacement: "bar",
        literal: true,
      }),
    ).toEqual({ files: 1, replacements: 1 });
  });

  // The reason this runs off the main thread at all: the pattern is client
  // input, and this one backtracks essentially forever. On the event loop it
  // would take every terminal websocket and poll down with it.
  it("gives up on a catastrophically backtracking pattern instead of hanging", async () => {
    const a = file("evil.txt", `${"a".repeat(4000)}b`);
    const started = Date.now();
    await expect(
      runReplace(
        { paths: [a], source: "(a+)+$", flags: "g", replacement: "x", literal: false },
        500,
      ),
    ).rejects.toBeInstanceOf(ReplaceTimeout);
    // Terminated, not merely abandoned: the promise settles on the budget.
    expect(Date.now() - started).toBeLessThan(4000);
    expect(fs.readFileSync(a, "utf8")).toBe(`${"a".repeat(4000)}b`);
  });
});
