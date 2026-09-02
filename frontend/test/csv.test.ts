import { describe, expect, it } from "vitest";
import { delimiterOf, parseCsv } from "../src/csv";

describe("parseCsv", () => {
  it("reads quoted cells, embedded separators and newlines", () => {
    const { rows } = parseCsv('name,note\n"Nordbye, M.","a ""quoted"" line\nand another"\n');
    expect(rows).toEqual([
      ["name", "note"],
      ["Nordbye, M.", 'a "quoted" line\nand another'],
    ]);
  });

  it("reads the semicolons a Norwegian Excel writes", () => {
    expect(delimiterOf("dato;beløp;tekst\n")).toBe(";");
    const { rows } = parseCsv("dato;beløp\n2026-01-02;1 234,50\n");
    expect(rows[1]).toEqual(["2026-01-02", "1 234,50"]);
  });

  it("keeps a last line that has no newline after it", () => {
    expect(parseCsv("a,b\n1,2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("stops at the row cap and says it did", () => {
    const text = ["h", ...Array.from({ length: 20 }, (_, i) => String(i))].join("\n") + "\n";
    const { rows, truncated } = parseCsv(text, 5);
    expect(rows.length).toBe(5);
    expect(truncated).toBe(true);
    expect(parseCsv(text, 500).truncated).toBe(false);
  });
});
