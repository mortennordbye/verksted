import fs from "node:fs/promises";
import path from "node:path";
import type { AssistantEntry } from "../../shared/api.js";
import { writeTextAtomic } from "./atomic-json.js";
import { env } from "./env.js";

/**
 * The journal: what was said, one short file per day.
 *
 * A thread is re-sent whole with every turn, which is why the chat suggests a
 * fresh one once it gets long and why a briefing starts with no yesterday in
 * it. Both are the right cost controls, and together they mean yesterday is
 * gone unless it was distilled into a fact. The journal is the distillation:
 * ten lines a day, written by the assistant at the end of it, and the last few
 * days are read at the start of every new thread and every briefing. That is
 * how "as we said yesterday" works without paying for yesterday.
 *
 * Plain files, one per day, so a day that was summarised badly is a file to
 * edit or delete rather than a row to migrate.
 */
export function journalDir(): string {
  return path.join(env.ASSISTANT_DIR, "journal");
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date in the bench's own timezone, which is the one the day ends in. */
export function today(now = new Date()): string {
  // sv-SE is the locale that spells a date 2026-08-30.
  return now.toLocaleDateString("sv-SE", { timeZone: env.TZ });
}

export async function readDay(day: string): Promise<string> {
  if (!DAY_RE.test(day)) return "";
  try {
    return await fs.readFile(path.join(journalDir(), `${day}.md`), "utf8");
  } catch {
    return "";
  }
}

export async function writeDay(day: string, text: string): Promise<void> {
  if (!DAY_RE.test(day)) throw new Error("not a day");
  await fs.mkdir(journalDir(), { recursive: true });
  await writeTextAtomic(path.join(journalDir(), `${day}.md`), `${text.trim()}\n`);
}

/**
 * The most recent days that have an entry, newest last, so a prompt reads
 * them in the order they happened.
 */
export async function recent(days = 3): Promise<{ day: string; text: string }[]> {
  let names: string[];
  try {
    names = await fs.readdir(journalDir());
  } catch {
    return [];
  }
  const found = names
    .filter((n) => n.endsWith(".md") && DAY_RE.test(n.slice(0, -3)))
    .map((n) => n.slice(0, -3))
    .sort()
    .slice(-days);
  const out: { day: string; text: string }[] = [];
  for (const day of found) {
    const text = (await readDay(day)).trim();
    if (text) out.push({ day, text });
  }
  return out;
}

/** What the last few days looked like, as the assistant is told it. */
export function render(entries: { day: string; text: string }[]): string {
  return entries.map((e) => `${e.day}\n${e.text}`).join("\n\n");
}

/**
 * The day's conversation, as material for the summary: what was typed and
 * what was answered, in order, capped so a long day is a long day and not a
 * megabyte. Tool chips are left out — what was decided is in the words.
 */
export const MATERIAL_BYTES = 24 * 1024;

export function material(entries: AssistantEntry[], day: string): string {
  const lines: string[] = [];
  let used = 0;
  for (const e of entries) {
    if (dayOf(e.at) !== day) continue;
    if (!e.text.trim()) continue;
    const who = e.role === "user" ? "you" : e.member || "assistant";
    const line = `${who}: ${e.text.trim().replace(/\s*\n\s*/g, " ")}`;
    if (used + line.length > MATERIAL_BYTES) break;
    used += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

/** The bench's date for a UTC timestamp. */
export function dayOf(iso: string): string {
  return today(new Date(iso));
}
