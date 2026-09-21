import { describe, expect, it } from "vitest";
import { lineRange } from "../src/lineRange";

/**
 * F-36. The file viewer draws a file as one element — plain text first, then
 * highlight.js's HTML, whose spans run across line breaks wherever a comment
 * or a string does — so finding a line means finding it in the text, and
 * mapping it back onto whatever nodes it landed in.
 */
const pre = (html: string) => {
  const el = document.createElement("pre");
  el.innerHTML = html;
  return el;
};

describe("lineRange", () => {
  it("finds a line in plain text", () => {
    const el = pre("one\ntwo\nthree");
    expect(lineRange(el, 1)!.toString()).toBe("one");
    expect(lineRange(el, 2)!.toString()).toBe("two");
    expect(lineRange(el, 3)!.toString()).toBe("three");
  });

  it("finds it across the spans a highlighter put round it", () => {
    // A block comment spanning lines two and three, the way hljs draws one.
    const el = pre(
      '<span class="k">const</span> a = 1;\n<span class="c">/* one\ntwo */</span> b(<span class="s">"x"</span>);\nend',
    );
    expect(lineRange(el, 2)!.toString()).toBe("/* one");
    expect(lineRange(el, 3)!.toString()).toBe('two */ b("x");');
    expect(lineRange(el, 4)!.toString()).toBe("end");
  });

  it("starts a line that begins where a node ends in the node it is in", () => {
    const el = pre('<span>first\n</span><span class="k">second</span>');
    const range = lineRange(el, 2)!;
    expect(range.toString()).toBe("second");
    // On the line, not at the end of the one before it: that is where the
    // browser would put the box the viewer scrolls to.
    expect(range.startContainer.textContent).toBe("second");
  });

  it("gives an empty line an empty range where it is", () => {
    const range = lineRange(pre("a\n\nb"), 2)!;
    expect(range.collapsed).toBe(true);
  });

  it("says nothing about a line past the end", () => {
    expect(lineRange(pre("a\nb"), 3)).toBeNull();
    expect(lineRange(pre("a\nb\n"), 3)).toBeNull();
  });
});
