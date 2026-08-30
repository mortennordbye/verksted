import fs from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "./atomic-json.js";
import { env } from "./env.js";

/**
 * The profile: what a new assistant would be told on its first day.
 *
 * One markdown file, yours to edit, carried in full at the top of every
 * conversation the assistant has. It is not the fact store: a fact is
 * something the bench learned about the work and is injected into every coding
 * session in every repo; the profile is who you are, the people who matter,
 * the standing arrangements, and what counts as urgent — which no coding
 * session needs and the assistant cannot do without.
 *
 * Free text rather than fields, because the shape of a life does not fit a
 * form and the model reads prose better than it reads JSON. Budgeted, because
 * every byte is re-sent with every turn.
 */
export const PROFILE_BUDGET = 8 * 1024;

export function profilePath(): string {
  return path.join(env.MEMORY_DIR, "profile.md");
}

export async function readProfile(): Promise<string> {
  try {
    return await fs.readFile(profilePath(), "utf8");
  } catch {
    return "";
  }
}

export async function writeProfile(text: string): Promise<void> {
  if (Buffer.byteLength(text) > PROFILE_BUDGET) {
    throw new Error(`the profile is capped at ${PROFILE_BUDGET} bytes`);
  }
  await fs.mkdir(env.MEMORY_DIR, { recursive: true });
  await writeTextAtomic(profilePath(), text.trimEnd() + (text.trim() ? "\n" : ""));
}

/**
 * One line added by the assistant when it is told something about the person
 * mid-conversation. Appended rather than merged, so what the assistant wrote
 * is always at the bottom and always yours to move or delete on the settings
 * page.
 */
export async function appendProfileLine(line: string): Promise<void> {
  const clean = line.replace(/\s*\n\s*/g, " ").trim();
  if (!clean) throw new Error("nothing to note");
  const current = await readProfile();
  const next = `${current.trimEnd()}${current.trim() ? "\n" : ""}- ${clean}\n`;
  await writeProfile(next);
}
