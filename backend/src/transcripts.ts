import { createReadStream } from "node:fs";
import readline from "node:readline";
import type { SessionPrompts } from "../../shared/api.js";
import { listSessions, readConv, sessionDir } from "./sessions-store.js";

/**
 * What the person actually typed, read back out of finished sessions.
 *
 * This is the raw material for learning without being asked, and the whole file
 * is one decision: **only human-typed turns leave here.** Not the model's
 * replies, not tool results, not file contents, not a PR body or a build log.
 *
 * That decision is doing two jobs at once, which is why it is worth stating
 * rather than inferring from the filter below.
 *
 * It is the cost control. A coding session's transcript is megabytes — file
 * reads, diffs, whole test runs — and feeding one to a model nightly would cost
 * more than everything else this app does put together. What a person types is
 * a few hundred bytes a session, so a night's harvest is a few kilobytes and
 * one round trip.
 *
 * And it is the injection defence. The stated fear about harvesting is that a
 * payload in a dependency's changelog becomes permanent context in every
 * session. Text like that arrives in tool *results*; it is never something the
 * user typed. Excluding everything else does not make harvesting safe on its
 * own — the review queue is what does that — but it means the material being
 * summarised is text this person wrote themselves.
 *
 * Claude Code tags each entry with its origin, so this is a property of the
 * record rather than a guess: `origin.kind === "human"` is the human at the
 * keyboard, and a tool result is `type: "user"` with structured content and no
 * such origin.
 */

/** Per prompt. Long enough to carry an instruction, short enough to be cheap. */
const MAX_PROMPT_CHARS = 400;
/** Per session, newest first: a long session repeats itself. */
const MAX_PROMPTS_PER_SESSION = 12;
/** Across the whole answer. A night that hits this had a very busy day. */
const MAX_TOTAL_CHARS = 8_000;

// Where claude keeps a conversation, and its subagents' conversations beside
// it (once interleaved into the parent's file, tagged `isSidechain`; the
// current CLI gives each its own file, named for the agent id the spawning
// call reports back — both shapes are still out there, which is why the
// parser keeps skipping the tagged ones). In claude-home.ts because the
// session store measures a finished session's transcript too, and it cannot
// import this file, which imports it.
import { subagentDir, transcriptPath } from "./claude-home.js";

export { subagentDir, transcriptPath };

/**
 * The human-typed turns of one transcript, oldest first.
 *
 * Read a line at a time. A long session's transcript runs to tens of megabytes
 * of tool results, and the nightly harvest used to hold each one whole, as a
 * string, to keep the few hundred characters a person typed into it.
 */
export async function promptsIn(file: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const lines = readline.createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity,
    });
    for await (const line of lines) read(line, out);
  } catch {
    // A session whose transcript was never written, or has been cleaned up.
  }
  return out;
}

/** One line of a transcript: kept only if a person typed it. */
function read(line: string, out: string[]): void {
  if (!line.startsWith("{")) return;
  let entry: {
    type?: string;
    origin?: { kind?: string };
    message?: { role?: string; content?: unknown };
  };
  try {
    entry = JSON.parse(line);
  } catch {
    // One torn line costs one turn, never the transcript.
    return;
  }
  // Both halves are required. `origin.kind` is what separates a person from a
  // tool result wearing the user role; the string check is what separates a
  // typed message from a structured one, whose parts are attachments and
  // results rather than words.
  if (entry.origin?.kind !== "human" || entry.message?.role !== "user") return;
  const text = typeof entry.message.content === "string" ? entry.message.content.trim() : "";
  if (text) out.push(text.slice(0, MAX_PROMPT_CHARS));
}

/**
 * Every session that ended in the last `hours`, with what its person typed.
 *
 * Sessions rather than transcripts, because a session is the thing that has a
 * project and an end time; the transcript is found from it through the
 * conversation id the session already records.
 */
export async function recentPrompts(
  hours: number,
): Promise<{ sessions: SessionPrompts[]; truncated: boolean }> {
  const since = Date.now() - hours * 60 * 60_000;
  const sessions: SessionPrompts[] = [];
  let total = 0;
  let truncated = false;

  for (const session of await listSessions()) {
    if (!session.endedAt || Date.parse(session.endedAt) < since) continue;
    const conversationId = await readConv(session.id);
    if (!conversationId) continue;
    let repoDir: string;
    try {
      repoDir = sessionDir(session);
    } catch {
      // The repo has since been deleted; there is nothing to read.
      continue;
    }
    const all = await promptsIn(transcriptPath(repoDir, conversationId));
    if (!all.length) continue;
    // Newest first when there are too many: the end of a session is where the
    // corrections are, and a correction is the fact worth keeping.
    const prompts: string[] = [];
    for (const prompt of all.slice(-MAX_PROMPTS_PER_SESSION)) {
      if (total + prompt.length > MAX_TOTAL_CHARS) {
        truncated = true;
        break;
      }
      total += prompt.length;
      prompts.push(prompt);
    }
    if (prompts.length) {
      sessions.push({
        sessionId: session.id,
        project: session.project,
        endedAt: session.endedAt,
        prompts,
      });
    }
    if (truncated) break;
  }
  return { sessions, truncated };
}
