import { describe, expect, it } from "vitest";
import type { Root } from "hast";
import { countMatches, rehypeMark, splitOn } from "../src/find";

describe("splitOn", () => {
  it("cuts the text at every match, case-insensitively", () => {
    expect(splitOn("Faktura for fakturaen", "faktura")).toEqual([
      { text: "Faktura", hit: true },
      { text: " for ", hit: false },
      { text: "faktura", hit: true },
      { text: "en", hit: false },
    ]);
  });

  it("is one run when nothing matches, and nothing at all with no query", () => {
    expect(splitOn("hei", "hopp")).toEqual([{ text: "hei", hit: false }]);
    expect(splitOn("hei", "")).toEqual([{ text: "hei", hit: false }]);
    expect(countMatches("hei", "")).toBe(0);
  });

  it("does not read a query as a regular expression", () => {
    expect(countMatches("a.b axb", "a.b")).toBe(1);
  });
});

describe("rehypeMark", () => {
  it("wraps the matches in a rendered tree, leaving the rest alone", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          properties: {},
          children: [{ type: "text", value: "the invoice is paid" }],
        },
      ],
    } as unknown as Root;
    rehypeMark("invoice")()(tree);
    const p = tree.children[0] as { children: { type: string; tagName?: string }[] };
    expect(p.children.map((c) => c.tagName ?? c.type)).toEqual(["text", "mark", "text"]);
  });
});
