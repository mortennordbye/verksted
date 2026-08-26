import type { TuiPrompt } from "../../shared/api.js";

/**
 * The menu the CLI is drawing right now, read off the pane.
 *
 * This is the one piece of this app that scrapes a TUI, and ASSISTANT.md is
 * right that scraping one is a bad bet: the byte stream belongs to the CLI, not
 * to us, and a release that redraws its dialogs will break every pattern below.
 *
 * It is here because there is no alternative. A permission prompt is drawn and
 * never written to the transcript, so the conversation on disk — which is where
 * everything else in the chat view comes from — cannot say that a session is
 * blocked, let alone on what. Reading the pane is the only way to know.
 *
 * So the bet is hedged rather than taken. Nothing here is required to work:
 * anything unrecognised returns null, and null is exactly what the screen did
 * before this file existed. The worst failure is a lost button, never a
 * keystroke sent at the wrong thing. `findMode` and `findAuthUrl` in
 * frontend/src/components/Terminal.tsx make the same bet the same way.
 *
 * Every rule below was read off a real pane rather than guessed.
 */

/** `  ❯ 1. Resume from summary` — the cursor is optional, the number is not. */
const OPTION_RE = /^\s*([❯>])?\s*(\d+)[.:]\s+(\S.*?)\s*$/;

/**
 * The line a blocking dialog signs off with. Its presence is not required —
 * some dialogs have none — but it is never on anything that is not one.
 */
const CAPTION_RE = /(enter to confirm|esc to cancel|esc to interrupt)/i;

/** The rules the composer is drawn between, and the status line under it. */
const CHROME_RE = /^[─━╌—\s]+$/;

/** Caps, so a pane full of numbered output cannot become a hundred buttons. */
const MAX_OPTIONS = 10;
const MAX_QUESTION = 200;
/** A wrapped question is a few lines; more than this is the history above it. */
const MAX_QUESTION_LINES = 4;
const MAX_LABEL = 120;

/**
 * What the pane is asking, or null when it is not asking anything.
 *
 * Read from the bottom, because a dialog is the last thing drawn and everything
 * above it is history. That is also the test for whether it is *blocking*: a
 * numbered list with a composer under it is not waiting on anybody. The CLI's
 * end-of-session survey looks exactly like a dialog and sits above a live
 * prompt with a half-typed message in it — drawing buttons for that would be
 * claiming a session is stuck when it is working.
 */
export function parsePrompt(pane: string): TuiPrompt | null {
  const lines = pane.split("\n").map((l) => l.replace(/\s+$/, ""));
  let i = lines.length - 1;

  // The sign-off, and any blank space under it.
  while (i >= 0 && (!lines[i] || CAPTION_RE.test(lines[i]))) i--;

  // Options, upwards, newest number first.
  const options: { number: number; label: string; selected: boolean }[] = [];
  while (i >= 0) {
    const m = OPTION_RE.exec(lines[i]);
    if (!m) break;
    options.unshift({
      number: Number(m[2]),
      label: m[3].slice(0, MAX_LABEL),
      selected: Boolean(m[1]),
    });
    i--;
  }
  // One numbered line is a list item in something the agent printed. Two that
  // do not run consecutively are as well.
  if (options.length < 2 || options.length > MAX_OPTIONS) return null;
  if (options.some((o, n) => n > 0 && o.number !== options[n - 1].number + 1)) return null;

  // Past any blank space between the options and what they are answering.
  while (i >= 0 && !lines[i].trim()) i--;

  // The question, which the CLI wraps to the pane width — so it is however many
  // lines run together above the options, not just the nearest one. Taking only
  // the nearest gives a fragment starting mid-sentence.
  const said: string[] = [];
  while (i >= 0 && said.length < MAX_QUESTION_LINES) {
    const line = lines[i].trim();
    if (!line || CHROME_RE.test(line) || OPTION_RE.test(line)) break;
    // The bullet the CLI puts on a prompt is not part of what it asked.
    said.unshift(line.replace(/^[●✻※⏺]\s*/, ""));
    i--;
  }
  const question = said.join(" ").trim().slice(0, MAX_QUESTION);
  if (!question) return null;
  return { question, options };
}
