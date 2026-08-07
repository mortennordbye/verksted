import fs from "node:fs/promises";
import path from "node:path";
import type { Memory, MemoryScope, MemoryType } from "../../shared/api.js";
import { env } from "./env.js";
import { MEMORY_FILES, mergeMarked } from "./sandbox-doc.js";

/**
 * What verksted has learned about how you work, as plain files on the volume.
 *
 * One fact per file, because that is what makes a wrong one deletable without a
 * migration and readable without this app: the store is a directory of markdown
 * you can edit in a terminal, and the agent that writes to it does so with the
 * ordinary Write tool rather than through a protocol of ours.
 *
 * The frontmatter is deliberately thin. `scope` decides who is told, `type` is
 * for the eye, and `source` is the answer to "why does it think that?" — the
 * question that makes a memory system trustworthy or not.
 */

const START = "<!-- verksted:memory start -->";
const END = "<!-- verksted:memory end -->";

/**
 * Everything kept is carried into every session, on a subscription where that
 * is real money per turn. The budget is the reason this needs no vector store:
 * a memory small enough to inject whole is a memory you can also read.
 */
export const BUDGET_BYTES = 8_000;

const TYPES: MemoryType[] = ["preference", "project", "reference"];
/** Slugs name files, so they may not reach outside the directory. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function filePath(slug: string): string {
  return path.join(env.MEMORY_DIR, `${slug}.md`);
}

interface Parsed {
  meta: Record<string, string>;
  body: string;
}

/**
 * Frontmatter, parsed forgivingly. The agent writes these files itself, so a
 * missing field is a normal Tuesday and must cost that one field rather than
 * the fact — a memory with no recorded source is still worth having.
 */
export function parseFile(raw: string): Parsed {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!match) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    meta[line.slice(0, at).trim()] = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
  }
  return { meta, body: raw.slice(match[0].length).trim() };
}

function toMemory(slug: string, raw: string, fallbackDate?: string): Memory | null {
  const { meta, body } = parseFile(raw);
  if (!body) return null;
  const type = TYPES.includes(meta.type as MemoryType) ? (meta.type as MemoryType) : "reference";
  return {
    slug,
    text: body,
    type,
    // Anything that is not a known project name is global; a fact scoped to a
    // repo that has since been deleted should still be told to somebody.
    scope: meta.scope && meta.scope !== "global" ? meta.scope : "global",
    source: meta.source || null,
    // The agent writes these files by hand and leaves `created` off as often as
    // not, and both the ordering and which facts the budget drops depend on it.
    // The file's own mtime is the answer that needs nothing from the agent.
    createdAt: meta.created || fallbackDate || null,
  };
}

export async function list(): Promise<Memory[]> {
  let files: string[];
  try {
    files = await fs.readdir(env.MEMORY_DIR);
  } catch {
    return [];
  }
  const out: Memory[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const full = path.join(env.MEMORY_DIR, file);
      const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const memory = toMemory(slug, raw, stat.mtime.toISOString());
      if (memory) out.push(memory);
    } catch {
      // An unreadable fact is one fact, not a broken memory.
    }
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

export async function save(input: {
  slug: string;
  text: string;
  type?: MemoryType;
  scope?: MemoryScope;
  source?: string;
}): Promise<Memory> {
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be lowercase words joined by dashes");
  const text = input.text.trim();
  if (!text) throw new Error("a memory needs something to remember");
  await fs.mkdir(env.MEMORY_DIR, { recursive: true });
  // Keep the original creation date when a fact is corrected rather than added:
  // "known since July" is part of what makes it trustworthy.
  const existing = await read(input.slug);
  const created = existing?.createdAt ?? new Date().toISOString();
  const front = [
    "---",
    `slug: ${input.slug}`,
    `type: ${input.type ?? "reference"}`,
    `scope: ${input.scope ?? "global"}`,
    `source: ${input.source ?? "asked directly"}`,
    `created: ${created}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
  await fs.writeFile(filePath(input.slug), front);
  await inject();
  return (await read(input.slug))!;
}

export async function read(slug: string): Promise<Memory | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    return toMemory(slug, await fs.readFile(filePath(slug), "utf8"));
  } catch {
    return null;
  }
}

export async function remove(slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;
  try {
    await fs.rm(filePath(slug));
    await inject();
    return true;
  } catch {
    return false;
  }
}

/**
 * The block every agent session is told, newest first until the budget runs
 * out. Newest first because a correction is written after the thing it
 * corrects, so the half that survives truncation should be the current half.
 */
export function renderBlock(memories: Memory[]): { text: string; used: number; dropped: number } {
  // Nothing learned yet is not the same as "here is what I learned: nothing",
  // which is what a header with no facts under it would tell every session.
  if (!memories.length) return { text: "", used: 0, dropped: 0 };
  const lines: string[] = [
    "What verksted has learned about how this person works. These are their own",
    "instructions, recorded earlier — follow them without being asked again.",
    "",
  ];
  let used = 0;
  let dropped = 0;
  for (const m of memories) {
    const prefix = m.scope === "global" ? "" : `In ${m.scope}: `;
    const line = `- ${prefix}${m.text.replace(/\s*\n\s*/g, " ")}`;
    if (used + line.length > BUDGET_BYTES) {
      dropped++;
      continue;
    }
    used += line.length;
    lines.push(line);
  }
  if (dropped) {
    lines.push(
      "",
      `(${dropped} older memories are not shown: the budget is full. Ask verksted to compact them.)`,
    );
  }
  return { text: lines.join("\n"), used, dropped };
}

/**
 * Write the block into every agent's global memory file.
 *
 * Global rather than per project, even for project-scoped facts, which is a
 * deliberate departure from the original plan: `.verksted/context.md` is only
 * read for prompted runs, and the alternative — writing into a repo's own
 * CLAUDE.md — would put verksted's guesses into a file that gets committed.
 * Labelling the scope inline costs a few words and reaches every session.
 */
export async function inject(home = process.env.HOME ?? "/data/home"): Promise<void> {
  const { text } = renderBlock(await list());
  for (const rel of MEMORY_FILES) {
    const file = path.join(home, rel);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const existing = await fs.readFile(file, "utf8").catch(() => "");
      const merged = mergeMarked(existing, START, END, text.trim() ? text : "");
      if (merged !== existing) await fs.writeFile(file, merged);
    } catch {
      // A memory that cannot be injected is still a memory; the next save
      // retries, and nothing here is worth failing a request over.
    }
  }
}
