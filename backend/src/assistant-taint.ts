import { CONNECTOR_CALL, CONNECTOR_MATCHER } from "./assistant-connectors.js";

/**
 * What a turn has already read, and what that costs it.
 *
 * A planted instruction needs three things to do harm: text somebody outside this
 * bench wrote (a mail, a document, a web page), the person's private data, and a
 * way out. A turn that has only done what the person asked has no planted
 * instruction in it, so it may read anything, in any order, browse, and carry out
 * what was asked. Only once it has read both a stranger's text and something
 * private is the way out shut: no web, no browser. And once it has read a
 * stranger's text at all, a change it wants becomes a card for the person to tap
 * (`isClean`, read by the proposals route).
 *
 * Per turn, because that is the unit a prompt injection acts within. The next
 * turn starts clean, and the person browsing the pane themselves is not a turn.
 */

/** Turn ids that have read something of the person's. Bounded: ids are per CLI run. */
const readPrivate = new Set<string>();
/** Turn ids that have read text somebody outside the bench wrote: mail, documents, pages. */
const readOutside = new Set<string>();

const MAX_REMEMBERED = 64;

function remember(set: Set<string>, turn: string): void {
  set.add(turn);
  // Oldest first, which is insertion order for a Set.
  for (const old of set) {
    if (set.size <= MAX_REMEMBERED) break;
    set.delete(old);
  }
}

/** Both halves: a planted instruction and something worth sending out. */
function exposed(turn: string): boolean {
  return readPrivate.has(turn) && readOutside.has(turn);
}

/**
 * Record a read the verksted server is about to serve. Says whether the browser has
 * to go first, which it does the moment a turn holds both halves.
 */
export function noteRead(turn: string, read: { private: boolean; outside: boolean }): boolean {
  if (read.private) remember(readPrivate, turn);
  if (read.outside) remember(readOutside, turn);
  return exposed(turn);
}

export function browsingBarred(turn: string | undefined): boolean {
  return turn !== undefined && exposed(turn);
}

/** Nothing this turn has read was written by somebody outside the bench. */
export function isClean(turn: string): boolean {
  return !readOutside.has(turn);
}

const WEB_CALL = /^(WebFetch$|WebSearch$|mcp__browser__)/;

/** What the PreToolUse hook matches on: every call the gate has an opinion about. */
export const GATED_TOOLS = `WebFetch|WebSearch|mcp__browser__.*|${CONNECTOR_MATCHER}`;

export type GateRuling = { allow: true; closeBrowser: boolean } | { allow: false; reason: string };

/**
 * Rule on one tool call before it runs, and record it in the same step, so two
 * calls made at once cannot both find the turn clean.
 */
export function ruleOnCall(turn: string, tool: string): GateRuling {
  if (WEB_CALL.test(tool)) {
    if (exposed(turn)) {
      return {
        allow: false,
        reason:
          "This turn has read text someone else wrote and the person's private data, so it cannot reach the web now. Answer from what you have; a fresh message can look it up.",
      };
    }
    // What comes back is a page somebody else wrote.
    remember(readOutside, turn);
    return { allow: true, closeBrowser: false };
  }
  if (CONNECTOR_CALL.test(tool)) {
    remember(readPrivate, turn);
    return { allow: true, closeBrowser: exposed(turn) };
  }
  // Only reachable if the matcher and these patterns part ways, and a call
  // nobody has ruled on is not one to wave through.
  return { allow: false, reason: `No rule covers ${tool}.` };
}

/** Test seam: module state, and a test file is one process. */
export function resetTaint(): void {
  readPrivate.clear();
  readOutside.clear();
}
