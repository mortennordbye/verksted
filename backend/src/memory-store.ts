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
  await fs.writeFile(
    filePath(input.slug),
    frontmatter(input.slug, text, {
      type: input.type,
      scope: input.scope,
      source: input.source ?? "asked directly",
      created,
    }),
  );
  await inject();
  return (await read(input.slug))!;
}

/**
 * A file the parser above will read back the same way.
 *
 * Field values are flattened to one line, because a newline inside one would
 * close it and let the rest be read as further fields — `source` reading
 * "harvested\nscope: global" would silently rewrite the scope of a fact.
 */
function frontmatter(
  slug: string,
  text: string,
  meta: { type?: MemoryType; scope?: MemoryScope; source?: string; created: string },
): string {
  const flat = (v: string) => v.replace(/\s*\n\s*/g, " ").trim();
  return [
    "---",
    `slug: ${slug}`,
    `type: ${meta.type ?? "reference"}`,
    `scope: ${flat(meta.scope ?? "global")}`,
    `source: ${flat(meta.source ?? "asked directly")}`,
    `created: ${meta.created}`,
    "---",
    "",
    text,
    "",
  ].join("\n");
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
 * What one advisor alone has been told.
 *
 * A directory per member rather than a `scope: council:michael` field, for the
 * reason the review queue below spells out at length: with a field every reader
 * has to filter, and one reader that forgets puts a private note into every
 * session in every repo. With a directory there is nothing to forget — `list()`
 * reads *.md at the top level and a subdirectory is not one, so the injected
 * block is trivially correct.
 *
 * It also sidesteps a hazard the scope field has no answer to: `toMemory` reads
 * any scope that is not "global" as a project name, so a member whose id
 * matched a repo would have its private notes printed into that repo's
 * sessions as "In michael: ...", with nothing to say it had happened.
 *
 * A smaller budget than the shared store, because this is carried on top of it.
 */
export const MEMBER_BUDGET_BYTES = 2_000;

function memberDir(id: string): string {
  return path.join(env.MEMORY_DIR, "members", id);
}

/** Facts only this advisor is told, newest first. */
export async function listForMember(id: string): Promise<Memory[]> {
  if (!SLUG_RE.test(id)) return [];
  const dir = memberDir(id);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const out: Memory[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const full = path.join(dir, file);
      const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const memory = toMemory(slug, raw, stat.mtime.toISOString());
      if (memory) out.push(memory);
    } catch {
      // An unreadable fact is one fact, not a broken memory.
    }
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/** The block one advisor carries in its own prompt. Never injected anywhere. */
export async function renderForMember(id: string): Promise<string> {
  return renderBlock(await listForMember(id), MEMBER_BUDGET_BYTES).text;
}

export async function saveForMember(
  id: string,
  input: { slug: string; text: string; type?: MemoryType; source?: string },
): Promise<Memory> {
  if (!SLUG_RE.test(id)) throw new Error("no such member");
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be lowercase words joined by dashes");
  const text = input.text.trim();
  if (!text) throw new Error("a memory needs something to remember");
  await fs.mkdir(memberDir(id), { recursive: true });
  const existing = (await listForMember(id)).find((m) => m.slug === input.slug);
  await fs.writeFile(
    path.join(memberDir(id), `${input.slug}.md`),
    frontmatter(input.slug, text, {
      type: input.type,
      // The scope is the directory. Writing one here would be a second answer
      // to the same question, and the two would disagree eventually.
      scope: "global",
      source: input.source ?? "asked directly",
      created: existing?.createdAt ?? new Date().toISOString(),
    }),
  );
  return (await listForMember(id)).find((m) => m.slug === input.slug)!;
}

export async function forgetForMember(id: string, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(id) || !SLUG_RE.test(slug)) return false;
  try {
    await fs.unlink(path.join(memberDir(id), `${slug}.md`));
    return true;
  } catch {
    return false;
  }
}

/**
 * The review queue: facts something proposed, which are not memory yet.
 *
 * A separate directory rather than a `status: proposed` field on a memory file,
 * which was the other candidate. The field would keep one store; the directory
 * keeps the injected block trivially correct, and that is worth more. With a
 * field, every reader has to filter, and one reader that forgets puts an
 * unreviewed fact — possibly one harvested from text nobody here wrote — into
 * every session in every repo. With a directory there is nothing to forget:
 * `list()` reads *.md at the top level and a subdirectory is not one.
 *
 * This gate is not a nicety and must not be removed to save a tap. Unreviewed
 * automatic memory poisons itself: one wrong fact silently degrades every later
 * session, and nothing in a bad answer points back at the fact that caused it.
 */
function proposalsDir(): string {
  return path.join(env.MEMORY_DIR, "proposed");
}

function proposalPath(slug: string): string {
  return path.join(proposalsDir(), `${slug}.md`);
}

export async function listProposals(): Promise<Memory[]> {
  const files = await fs.readdir(proposalsDir()).catch(() => []);
  const out: Memory[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const full = path.join(proposalsDir(), file);
      const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const memory = toMemory(slug, raw, stat.mtime.toISOString());
      if (memory) out.push(memory);
    } catch {
      // An unreadable proposal is one proposal.
    }
  }
  return out.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Put a fact in the queue. Keyed by slug, so a harvest that runs twice over the
 * same day replaces its own proposal instead of stacking duplicates.
 */
export async function propose(input: {
  slug: string;
  text: string;
  type?: MemoryType;
  scope?: MemoryScope;
  source?: string;
}): Promise<Memory> {
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be lowercase words joined by dashes");
  const text = input.text.trim();
  if (!text) throw new Error("a memory needs something to remember");
  // Proposing something already known is noise in the queue, not a correction:
  // correcting a kept fact is a thing the person does, in the settings page.
  if (await read(input.slug)) throw new Error(`${input.slug} is already remembered`);
  await fs.mkdir(proposalsDir(), { recursive: true });
  await fs.writeFile(
    proposalPath(input.slug),
    frontmatter(input.slug, text, {
      type: input.type,
      scope: input.scope,
      // Provenance matters more here than anywhere else: this is the field that
      // answers "why does it think that?" about a fact nobody typed.
      source: input.source ?? "harvested",
      created: new Date().toISOString(),
    }),
  );
  return (await readProposal(input.slug))!;
}

async function readProposal(slug: string): Promise<Memory | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    return toMemory(slug, await fs.readFile(proposalPath(slug), "utf8"));
  } catch {
    return null;
  }
}

/** Accept a proposal: it becomes memory, and reaches every session from now. */
export async function keep(slug: string): Promise<Memory | null> {
  const proposal = await readProposal(slug);
  if (!proposal) return null;
  const kept = await save({
    slug: proposal.slug,
    text: proposal.text,
    type: proposal.type,
    scope: proposal.scope,
    source: proposal.source ?? "harvested",
  });
  await fs.rm(proposalPath(slug), { force: true });
  return kept;
}

/** Reject one. It leaves no trace, which is the point of a queue. */
export async function dropProposal(slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;
  if (!(await readProposal(slug))) return false;
  await fs.rm(proposalPath(slug), { force: true });
  return true;
}

/**
 * The two halves of what is known, and the order they are told in.
 *
 * A flat list of facts is not the same thing as knowing somebody. Who this
 * person is comes first and stays together, because it is what an agent should
 * read before it decides how to answer anything; the mechanics of a particular
 * repo are reference material, and reference material belongs underneath. It
 * costs two lines and it is the difference between a bag of facts and a
 * briefing on the person you are working for.
 */
const SECTIONS: { types: MemoryType[]; heading: string }[] = [
  {
    types: ["preference"],
    heading:
      "Who this person is, and how they want things done. These are their own instructions, recorded earlier — follow them without being asked again.",
  },
  {
    types: ["project", "reference"],
    heading:
      "What verksted has learned about the work here. Facts, not instructions: use them, and say so if one turns out to be wrong.",
  },
];

/**
 * The block every agent session is told, newest first until the budget runs
 * out. Newest first because a correction is written after the thing it
 * corrects, so the half that survives truncation should be the current half.
 *
 * The budget is spent in that one global order, before anything is grouped, so
 * which facts survive does not depend on which section they land in — only
 * where they are printed does.
 */
export function renderBlock(
  memories: Memory[],
  budget = BUDGET_BYTES,
): { text: string; used: number; dropped: number } {
  // Nothing learned yet is not the same as "here is what I learned: nothing",
  // which is what a header with no facts under it would tell every session.
  if (!memories.length) return { text: "", used: 0, dropped: 0 };
  // The headings are carried into every session exactly as the facts are, so
  // they are reserved before anything is fitted rather than added afterwards —
  // otherwise a full store overshoots the budget by the size of its own
  // headings, and the number reported for it would be a number that lies.
  const overhead = SECTIONS.reduce((n, s) => n + s.heading.length, 0);
  const kept: Memory[] = [];
  let used = 0;
  let dropped = 0;
  for (const m of memories) {
    const line = renderLine(m);
    if (used + line.length > budget - overhead) {
      dropped++;
      continue;
    }
    used += line.length;
    kept.push(m);
  }
  const lines: string[] = [];
  for (const section of SECTIONS) {
    const mine = kept.filter((m) => section.types.includes(m.type));
    if (!mine.length) continue;
    if (lines.length) lines.push("");
    used += section.heading.length;
    lines.push(section.heading, "", ...mine.map(renderLine));
  }
  if (dropped) {
    lines.push(
      "",
      `(${dropped} older memories are not shown: the budget is full. Ask verksted to compact them.)`,
    );
  }
  return { text: lines.join("\n"), used, dropped };
}

function renderLine(m: Memory): string {
  const prefix = m.scope === "global" ? "" : `In ${m.scope}: `;
  return `- ${prefix}${m.text.replace(/\s*\n\s*/g, " ")}`;
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
