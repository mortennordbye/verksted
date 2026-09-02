import type { ReactNode } from "react";
import type { Root } from "hast";

/**
 * Find inside what is on the screen: the same literal, case-insensitive match
 * a person means by "where does it say that", marked in place.
 *
 * Literal rather than a regular expression on purpose — the query arrives from
 * the share's own search box, where people type file names and dates, and half
 * of those characters mean something else to a regex.
 */

export const MARK_CLS = "rounded-[3px] bg-wait/30 text-text";

/** The text, cut at every match. Marked runs alternate with plain ones. */
export function splitOn(text: string, query: string): { text: string; hit: boolean }[] {
  if (!query) return [{ text, hit: false }];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: { text: string; hit: boolean }[] = [];
  let at = 0;
  for (;;) {
    const found = hay.indexOf(needle, at);
    if (found === -1) {
      if (at < text.length) parts.push({ text: text.slice(at), hit: false });
      return parts;
    }
    if (found > at) parts.push({ text: text.slice(at, found), hit: false });
    parts.push({ text: text.slice(found, found + needle.length), hit: true });
    at = found + needle.length;
  }
}

/** How many times the query occurs, counted the way splitOn cuts. */
export function countMatches(text: string, query: string): number {
  if (!query) return 0;
  return splitOn(text, query).filter((p) => p.hit).length;
}

/** One string, with its matches wrapped in <mark>. */
export function marks(text: string, query: string): ReactNode {
  if (!query) return text;
  return splitOn(text, query).map((p, i) =>
    p.hit ? (
      <mark key={i} className={MARK_CLS}>
        {p.text}
      </mark>
    ) : (
      p.text
    ),
  );
}

/** A hast node as this walker needs it, which is a parent and a text node. */
interface Node {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

function markNode(node: Node, query: string): void {
  if (!node.children) return;
  const out: Node[] = [];
  for (const child of node.children) {
    if (child.type !== "text" || !child.value) {
      markNode(child, query);
      out.push(child);
      continue;
    }
    for (const part of splitOn(child.value, query)) {
      out.push(
        part.hit
          ? {
              type: "element",
              tagName: "mark",
              properties: { className: [MARK_CLS] },
              children: [{ type: "text", value: part.text }],
            }
          : { type: "text", value: part.text },
      );
    }
  }
  node.children = out;
}

/**
 * The same marking for rendered markdown, where the text is inside a tree
 * rather than in a string. Runs on the hast, after the markdown is parsed, so
 * a match spanning `**bold**` is not found — which is the honest answer: on
 * screen those are two runs of text with a style between them.
 */
export function rehypeMark(query: string) {
  // The tree is hast's Root; this walker only needs "a node with children",
  // which every node in it is.
  return () => (tree: Root) => {
    if (query) markNode(tree, query);
  };
}
