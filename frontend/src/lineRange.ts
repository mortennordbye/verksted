/**
 * The DOM range covering one line of the text drawn inside `root`, 1-based.
 *
 * The file viewer draws a file as one `<pre>`: plain text first, then the same
 * text as highlight.js's HTML, whose spans cross line breaks wherever a comment
 * or a string does. So a line is found in the text the element holds, not in
 * its markup, and mapped back onto whichever text nodes it fell into. Null for
 * a line past the end.
 */
export function lineRange(root: HTMLElement, line: number): Range | null {
  const text = root.textContent ?? "";
  let start = 0;
  for (let n = 1; n < line; n++) {
    const next = text.indexOf("\n", start);
    if (next === -1) return null;
    start = next + 1;
  }
  const newline = text.indexOf("\n", start);
  const end = newline === -1 ? text.length : newline;

  const range = document.createRange();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let at = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = (node as Text).length;
    // Strictly inside, so a line that begins exactly where a node ends is
    // started in the next node — on the line itself, not at the end of the
    // one before it, which is where a browser would then draw its box.
    if (!started && start < at + length) {
      range.setStart(node, start - at);
      started = true;
    }
    if (started && end <= at + length) {
      range.setEnd(node, end - at);
      return range;
    }
    at += length;
  }
  return null;
}
