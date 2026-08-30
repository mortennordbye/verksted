import fs from "node:fs/promises";
import path from "node:path";
import type { DocEntry, DocHit } from "../../shared/api.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js";
import { env } from "./env.js";
import { exec } from "./exec.js";
import { resolveInside } from "./paths.js";

/**
 * The documents: a share mounted read-only, and what is made of it.
 *
 * Two halves. Search is the half a person asks for: a nightly sweep extracts
 * the text of every document that has one (pdftotext, pandoc, or the file
 * itself) into one sidecar per document under DOCS_INDEX_DIR, keyed by path
 * and mtime, and search is words over those sidecars. No embeddings and no
 * database, for the reason the memory store has none: a few hundred megabytes
 * of text on a volume this pod owns is something grep answers in well under a
 * second.
 *
 * The catalogue is the half that makes documents useful without being asked:
 * one line per document, written by a cheap model turn a few documents a night
 * (see scheduler.ts), saying what it is, who it is with, and every date in it
 * that means something. Renewals and notice periods become loops. It is a
 * markdown file you can read and correct.
 *
 * Every path is resolved inside DOCS_DIR by realpath, and the share is mounted
 * read-only at the volume, so nothing here can write to it even by accident.
 */
export class DocsUnavailable extends Error {}

/** Extensions read as they are, and those an extractor turns into text. */
const PLAIN = new Set([".txt", ".md", ".markdown", ".csv", ".json", ".log", ".eml", ".ics"]);
const PDF = new Set([".pdf"]);
const PANDOC = new Set([".docx", ".odt", ".rtf", ".epub", ".html", ".htm"]);
/** Listed, never read: a scan is a picture until somebody decides to pay to read it. */
const LISTED_ONLY = new Set([".jpg", ".jpeg", ".png", ".heic", ".tif", ".tiff", ".gif"]);

export function kindOf(file: string): "plain" | "pdf" | "pandoc" | "image" | "other" {
  const ext = path.extname(file).toLowerCase();
  if (PLAIN.has(ext)) return "plain";
  if (PDF.has(ext)) return "pdf";
  if (PANDOC.has(ext)) return "pandoc";
  if (LISTED_ONLY.has(ext)) return "image";
  return "other";
}

export async function configured(): Promise<boolean> {
  try {
    return (await fs.stat(env.DOCS_DIR)).isDirectory();
  } catch {
    return false;
  }
}

async function root(): Promise<string> {
  if (!(await configured())) {
    throw new DocsUnavailable(`no documents: nothing is mounted at ${env.DOCS_DIR}`);
  }
  return env.DOCS_DIR;
}

/** The share's own relative path of a real path under it. */
function relOf(real: string, base: string): string {
  return path.relative(base, real).split(path.sep).join("/");
}

/** One directory, as a listing: folders first, then files, with what each is. */
export async function list(rel = ""): Promise<DocEntry[]> {
  const base = await root();
  const dir = resolveInside(base, rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: DocEntry[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat) continue;
    out.push({
      path: relOf(full, await fs.realpath(base)),
      name: e.name,
      dir: stat.isDirectory(),
      size: stat.isDirectory() ? 0 : stat.size,
      modified: stat.mtime.toISOString(),
      kind: stat.isDirectory() ? "dir" : kindOf(e.name),
    });
  }
  return out.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
}

/** Every readable document under the share, for the sweep and the catalogue. */
export async function walk(): Promise<{ rel: string; mtime: number; size: number }[]> {
  const base = await fs.realpath(await root());
  const out: { rel: string; mtime: number; size: number }[] = [];
  const visit = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!e.isFile() || kindOf(e.name) === "image" || kindOf(e.name) === "other") continue;
      const stat = await fs.stat(full).catch(() => null);
      if (stat) out.push({ rel: relOf(full, base), mtime: stat.mtimeMs, size: stat.size });
    }
  };
  await visit(base);
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Where a document's text lives once extracted. */
function sidecar(rel: string): string {
  return path.join(env.DOCS_INDEX_DIR, "text", `${rel}.txt`);
}

/** What a model or a person is handed of one document. */
export const READ_BYTES = 24 * 1024;
/** Files bigger than this are listed and skipped: the sweep is for documents, not archives. */
const MAX_EXTRACT_BYTES = 40 * 1024 * 1024;

/**
 * The text of one document, extracted now. Returns null for a file this
 * bench cannot read: a scan, an unknown type, an extractor that is not
 * installed, which is a thing to say rather than an error to throw.
 */
export async function extract(real: string): Promise<string | null> {
  const kind = kindOf(real);
  try {
    if (kind === "plain") return await fs.readFile(real, "utf8");
    if (kind === "pdf") {
      const { stdout } = await exec("pdftotext", ["-layout", "-enc", "UTF-8", real, "-"], {
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    }
    if (kind === "pandoc") {
      const { stdout } = await exec("pandoc", ["-t", "plain", "--wrap=none", real], {
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Extract what has changed since the last sweep, a bounded number at a time.
 * Keyed by mtime: a document edited on the share is re-read, one that is not
 * costs a stat.
 */
export async function sweep(limit = 200): Promise<{ extracted: number; skipped: number }> {
  const base = await fs.realpath(await root());
  let extracted = 0;
  let skipped = 0;
  for (const doc of await walk()) {
    if (extracted >= limit) break;
    const side = sidecar(doc.rel);
    const have = await fs.stat(side).catch(() => null);
    if (have && have.mtimeMs >= doc.mtime) continue;
    if (doc.size > MAX_EXTRACT_BYTES) {
      skipped++;
      continue;
    }
    const text = await extract(path.join(base, doc.rel));
    if (text === null) {
      skipped++;
      continue;
    }
    await fs.mkdir(path.dirname(side), { recursive: true });
    await writeTextAtomic(side, text);
    extracted++;
  }
  return { extracted, skipped };
}

/** One document's text: the sidecar if the sweep has been, else extracted now. */
export async function read(rel: string): Promise<{ path: string; text: string } | null> {
  const base = await root();
  const real = resolveInside(base, rel);
  const stat = await fs.stat(real);
  if (!stat.isFile()) return null;
  const side = sidecar(relOf(real, await fs.realpath(base)));
  let text = await fs.readFile(side, "utf8").catch(() => null);
  if (text === null) text = await extract(real);
  if (text === null) return { path: rel, text: "(this bench cannot read this kind of file)" };
  return {
    path: rel,
    text:
      text.length > READ_BYTES
        ? `${text.slice(0, READ_BYTES)}\n[cut at ${READ_BYTES} bytes]`
        : text,
  };
}

/**
 * Words over the sidecars, all required, case-insensitive, with the matching
 * line as the excerpt. The catalogue is searched first, since "the contract
 * with the builder" is answered by its line before any body is opened.
 */
export async function search(query: string, limit = 12): Promise<DocHit[]> {
  await root();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const textDir = path.join(env.DOCS_INDEX_DIR, "text");
  const hits: DocHit[] = [];
  const catalogue = await readCatalogue();
  for (const [rel, entry] of Object.entries(catalogue)) {
    const line = entry.line.toLowerCase();
    if (words.every((w) => line.includes(w))) hits.push({ path: rel, excerpt: entry.line });
  }
  const visit = async (dir: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (hits.length >= limit) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await visit(full);
        continue;
      }
      if (!e.name.endsWith(".txt")) continue;
      const rel = path.relative(textDir, full).slice(0, -4).split(path.sep).join("/");
      if (hits.some((h) => h.path === rel)) continue;
      const text = await fs.readFile(full, "utf8").catch(() => "");
      const lower = text.toLowerCase();
      if (!words.every((w) => lower.includes(w))) continue;
      const at = lower.indexOf(words[0]);
      const from = Math.max(0, text.lastIndexOf("\n", at) + 1);
      const to = text.indexOf("\n", at);
      hits.push({
        path: rel,
        excerpt: text
          .slice(from, to < 0 ? undefined : to)
          .trim()
          .slice(0, 240),
      });
    }
  };
  await visit(textDir);
  return hits.slice(0, limit);
}

/** What the catalogue keeps per document: the line, and the dates it named. */
export interface CatalogueEntry {
  line: string;
  /** YYYY-MM-DD and what it is, as the model wrote them. */
  dates: { on: string; what: string }[];
  at: string;
}

function cataloguePath(): string {
  return path.join(env.DOCS_INDEX_DIR, "catalogue.json");
}

export async function readCatalogue(): Promise<Record<string, CatalogueEntry>> {
  try {
    return JSON.parse(await fs.readFile(cataloguePath(), "utf8")) as Record<string, CatalogueEntry>;
  } catch {
    return {};
  }
}

export async function writeCatalogue(entries: Record<string, CatalogueEntry>): Promise<void> {
  await fs.mkdir(env.DOCS_INDEX_DIR, { recursive: true });
  await writeJsonAtomic(cataloguePath(), entries);
  // The readable copy, for a person: one line per document, newest first.
  const lines = Object.entries(entries)
    .sort((a, b) => b[1].at.localeCompare(a[1].at))
    .map(
      ([rel, e]) =>
        `- ${rel}: ${e.line}${e.dates.length ? ` (${e.dates.map((d) => `${d.on} ${d.what}`).join("; ")})` : ""}`,
    );
  await writeTextAtomic(
    path.join(env.DOCS_INDEX_DIR, "catalogue.md"),
    `# What is on the share\n\n${lines.join("\n")}\n`,
  );
}

/** Documents with text that the catalogue has not read yet, oldest sweep first. */
export async function uncatalogued(limit: number): Promise<{ rel: string; head: string }[]> {
  const catalogue = await readCatalogue();
  const out: { rel: string; head: string }[] = [];
  for (const doc of await walk()) {
    if (out.length >= limit) break;
    if (catalogue[doc.rel]) continue;
    const text = await fs.readFile(sidecar(doc.rel), "utf8").catch(() => null);
    if (text === null || !text.trim()) continue;
    out.push({ rel: doc.rel, head: text.replace(/\s+/g, " ").trim().slice(0, 2000) });
  }
  return out;
}

/** The catalogue, as the specialist and a person read it. */
export async function catalogueText(): Promise<string> {
  return fs.readFile(path.join(env.DOCS_INDEX_DIR, "catalogue.md"), "utf8").catch(() => "");
}
