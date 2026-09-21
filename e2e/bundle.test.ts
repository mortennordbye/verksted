import { gzipSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the app weighs, checked against the build rather than against a promise.
 *
 * F-13 from the audit: the file-type icons are 1,226 SVGs of a kilobyte or two,
 * and Vite inlines anything under four. They were base64'd into the chunk of
 * the one screen that draws a file tree — 2.2 MB of it, 437 KB gzipped, which
 * is what a notification tapped on a phone downloads and parses before the
 * terminal appears. highlight.js's grammars sat in the same chunk for a viewer
 * most visits never open.
 *
 * Both are one line of config away from coming back, and neither shows up as a
 * failure anywhere else: the app works exactly as well, it just costs a phone
 * half a megabyte. Hence a test rather than a comment.
 */
const DIST = path.resolve(import.meta.dirname, "..", "frontend", "dist", "assets");

/** Gzipped, because that is what crosses the tunnel. */
const gzipped = (file: string) => gzipSync(fs.readFileSync(path.join(DIST, file))).length;

const chunks = () => fs.readdirSync(DIST).filter((f) => f.endsWith(".js"));

describe("the built bundle", () => {
  it("serves the file icons as files, not as data URIs in a chunk", () => {
    const icons = fs.readdirSync(path.join(DIST, "icons"));
    expect(icons.length).toBeGreaterThan(1000);
    for (const chunk of chunks()) {
      const js = fs.readFileSync(path.join(DIST, chunk), "utf8");
      expect(js, `${chunk} inlines an icon`).not.toContain("data:image/svg");
    }
  });

  it("keeps the heaviest chunk inside what a phone should wait for", () => {
    const worst = chunks()
      .map((f) => ({ f, size: gzipped(f) }))
      .sort((a, b) => b.size - a.size)[0];
    // 199 KB when this was written, against 437 KB before. The headroom is for
    // ordinary growth; a jump past it means something large went in eagerly.
    expect(worst.size, `${worst.f} is ${Math.round(worst.size / 1024)} KB gzipped`).toBeLessThan(
      280 * 1024,
    );
  });

  it("fetches the syntax highlighter only when a file is opened", () => {
    // Its own chunk, which is what "loaded on demand" looks like from here: no
    // static importer, so nothing pulls it in before `highlight()` is called.
    const entry = chunks().filter((f) => f.startsWith("Session-"));
    expect(entry).toHaveLength(1);
    const js = fs.readFileSync(path.join(DIST, entry[0]), "utf8");
    // The library names itself in its own chunk; the session's chunk knows it
    // only as a dynamic import.
    expect(js).not.toContain("highlight.js");
    const lazy = chunks().filter((f) => {
      return fs.readFileSync(path.join(DIST, f), "utf8").includes("highlight.js");
    });
    expect(lazy).toHaveLength(1);
  });
});
