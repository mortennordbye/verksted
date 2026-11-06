import fs from "node:fs/promises";
import path from "node:path";
import type { Skill } from "../../shared/api.js";
import { writeTextAtomic } from "./atomic-json.js";
import { env } from "./env.js";
import { parseFile } from "./memory-store.js";

/**
 * The assistant's skills: procedures it wrote for itself after a task that
 * worked, so the next time the same kind of task comes it follows the steps
 * instead of finding them again.
 *
 * Memory says how the person works; a skill says how a job is done. Only the
 * one-line descriptions go into the chair's prompt (`renderIndex`), and the
 * chair reads a body with `use_skill` when a task fits it. That keeps the
 * prompt small however many skills there are.
 *
 * A skill is instructions the chair will follow later, so one written on a
 * turn that had read a stranger's text waits in `proposed/` until the person
 * keeps it. The route decides that, from the backend's own taint state.
 */

export const DESCRIPTION_MAX = 200;
export const BODY_MAX = 4000;
/** Enough for every job worth a procedure, few enough to read the list. */
export const MAX_SKILLS = 50;
/** The index is carried in every chair turn. */
export const INDEX_BUDGET_BYTES = 2000;

/** Slugs name files, so they may not reach outside the directory. Same rule as memory's. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The one way a slug becomes a path: checked here, where the path is made. */
function fileOf(from: string, slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error("slug must be lowercase words joined by dashes");
  return path.join(from, `${slug}.md`);
}

function dir(): string {
  return env.SKILLS_DIR;
}

function proposedDir(): string {
  return path.join(env.SKILLS_DIR, "proposed");
}

function toSkill(slug: string, raw: string, mtime?: string): Skill | null {
  const { meta, body } = parseFile(raw);
  if (!body) return null;
  return {
    slug,
    description: meta.description || slug,
    body,
    source: meta.source || null,
    createdAt: meta.created || mtime || null,
    updatedAt: meta.updated || mtime || null,
  };
}

async function readAll(from: string): Promise<Skill[]> {
  const files = await fs.readdir(from).catch(() => [] as string[]);
  const out: Skill[] = [];
  for (const file of files) {
    if (!file.endsWith(".md")) continue;
    const slug = file.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      const full = path.join(from, file);
      const [raw, stat] = await Promise.all([fs.readFile(full, "utf8"), fs.stat(full)]);
      const skill = toSkill(slug, raw, stat.mtime.toISOString());
      if (skill) out.push(skill);
    } catch {
      // An unreadable skill is one skill.
    }
  }
  return out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

async function readOne(from: string, slug: string): Promise<Skill | null> {
  if (!SLUG_RE.test(slug)) return null;
  try {
    return toSkill(slug, await fs.readFile(fileOf(from, slug), "utf8"));
  } catch {
    return null;
  }
}

export const list = () => readAll(dir());
export const listProposals = () => readAll(proposedDir());
export const read = (slug: string) => readOne(dir(), slug);

interface Input {
  slug: string;
  description: string;
  body: string;
  source?: string;
}

/** Field values on one line, so a newline cannot start a field of its own. */
const flat = (v: string) => v.replace(/\s+/g, " ").trim();

function check(input: Input): { description: string; body: string } {
  if (!SLUG_RE.test(input.slug)) throw new Error("slug must be lowercase words joined by dashes");
  const description = flat(input.description);
  const body = input.body.trim();
  if (!description) throw new Error("a skill needs a line that says when to use it");
  if (!body) throw new Error("a skill needs its steps");
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`the description is longer than ${DESCRIPTION_MAX} characters`);
  }
  if (body.length > BODY_MAX) throw new Error(`the steps are longer than ${BODY_MAX} characters`);
  return { description, body };
}

async function write(to: string, input: Input, created: string): Promise<void> {
  const { description, body } = check(input);
  await fs.mkdir(to, { recursive: true });
  await writeTextAtomic(
    fileOf(to, input.slug),
    [
      "---",
      `slug: ${input.slug}`,
      `description: ${description}`,
      `source: ${flat(input.source ?? "asked directly")}`,
      `created: ${created}`,
      `updated: ${new Date().toISOString()}`,
      "---",
      "",
      body,
      "",
    ].join("\n"),
  );
}

/** Add or rewrite a skill. A rewrite keeps the date it was first written. */
export async function save(input: Input): Promise<Skill> {
  const existing = await read(input.slug);
  if (!existing && (await list()).length >= MAX_SKILLS) {
    throw new Error(`there are already ${MAX_SKILLS} skills; forget one first`);
  }
  await write(dir(), input, existing?.createdAt ?? new Date().toISOString());
  return (await read(input.slug))!;
}

/** Put a skill in the queue. Nothing reads it until it is kept. */
export async function propose(input: Input): Promise<Skill> {
  await write(proposedDir(), input, new Date().toISOString());
  return (await readOne(proposedDir(), input.slug))!;
}

export async function keep(slug: string): Promise<Skill | null> {
  const proposal = await readOne(proposedDir(), slug);
  if (!proposal) return null;
  const kept = await save({
    slug,
    description: proposal.description,
    body: proposal.body,
    source: proposal.source ?? undefined,
  });
  await fs.rm(fileOf(proposedDir(), slug), { force: true });
  return kept;
}

async function rm(from: string, slug: string): Promise<boolean> {
  if (!SLUG_RE.test(slug)) return false;
  try {
    await fs.rm(fileOf(from, slug));
    return true;
  } catch {
    return false;
  }
}

export const remove = (slug: string) => rm(dir(), slug);
export const drop = (slug: string) => rm(proposedDir(), slug);

/**
 * What the chair is told it knows how to do: one line per skill, newest first,
 * cut at the budget. A skill past the cut is still there for `use_skill`.
 */
export function renderIndex(skills: Skill[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const s of skills) {
    const line = `- ${s.slug}: ${s.description}`;
    used += Buffer.byteLength(line) + 1;
    if (used > INDEX_BUDGET_BYTES) {
      lines.push(`- (${skills.length - lines.length} more; ask list_skills)`);
      break;
    }
    lines.push(line);
  }
  return lines.join("\n");
}
