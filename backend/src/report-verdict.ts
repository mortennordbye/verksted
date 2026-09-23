/**
 * The verdict a report opens with, or null when it opens with none of the
 * three. The one reading of it: the session list, the schedule history and
 * the notifier each had their own copy of these regexes (R-34).
 */
export function reportVerdict(report: string | null): "ok" | "attention" | "failed" | null {
  const word = report ? /^(ok|attention|failed)\b/i.exec(report)?.[1] : undefined;
  return word ? (word.toLowerCase() as "ok" | "attention" | "failed") : null;
}
