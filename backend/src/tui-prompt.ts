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

/**
 * `  ❯ 1. Resume from summary`, or `  2. [✔] Weed the beds`.
 *
 * The cursor is optional and the number is not. The box is what says this is a
 * question with several answers rather than one — the CLI draws no other
 * marker for it that survives to the pane.
 */
const OPTION_RE = /^\s*([❯>])?\s*(\d+)[.:]\s+(?:\[([^\]]*)\]\s+)?(\S.*?)\s*$/;

/**
 * The line a blocking dialog signs off with. Its presence is not required —
 * some dialogs have none — but it is never on anything that is not one.
 */
const CAPTION_RE = /(enter to confirm|esc to cancel|esc to interrupt)/i;

/**
 * An option's own description, written under it.
 *
 * Any indent at all, because the CLI does not use a consistent one: a
 * single-select indents a description well past its number, a multi-select
 * lines it up with the option above it. What keeps this from swallowing the
 * question is the blank line the CLI always leaves between the two, which stops
 * the walk before it gets here.
 */
const DESCRIPTION_RE = /^\s+\S/;

/** The rules the composer is drawn between, and the status line under it. */
const CHROME_RE = /^[─━╌—\s]+$/;

/** Caps, so a pane full of numbered output cannot become a hundred buttons. */
const MAX_OPTIONS = 10;
const MAX_QUESTION = 200;
/** Above this is the conversation, not the dialog. */
const MAX_BODY_LINES = 12;
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

  // Options, upwards, newest number first. Two things sit between them and are
  // stepped over rather than treated as the end of the list: an AskUserQuestion
  // writes a description under each option, and draws a rule between the real
  // answers and the "chat about this" escape hatch below them.
  const options: TuiPrompt["options"] = [];
  while (i >= 0) {
    const line = lines[i];
    const m = OPTION_RE.exec(line);
    if (m) {
      const box = m[3];
      options.unshift({
        number: Number(m[2]),
        label: m[4].slice(0, MAX_LABEL),
        selected: Boolean(m[1]),
        // Anything in the box but space is a tick; the CLI has used more than
        // one glyph for it.
        ...(box === undefined ? {} : { checked: box.trim() !== "" }),
      });
      i--;
      continue;
    }
    // Only once inside the list, so neither can be what starts one. A blank is
    // deliberately not stepped over: it is what stops the walk climbing out of
    // the dialog and into whatever the agent printed above it.
    const inside = options.length > 0;
    if (inside && line.trim() && CHROME_RE.test(line.trim())) {
      i--;
      continue;
    }
    if (inside && DESCRIPTION_RE.test(line)) {
      i--;
      continue;
    }
    break;
  }
  // One numbered line is a list item in something the agent printed. Two that
  // do not run consecutively are as well.
  if (options.length < 2 || options.length > MAX_OPTIONS) return null;
  if (options.some((o, n) => n > 0 && o.number !== options[n - 1].number + 1)) return null;

  // Everything above the options that is still part of the dialog, up to the
  // rule that separates it from the conversation. Read as paragraphs, because
  // the CLI both wraps a sentence across lines and separates its parts with
  // blank ones — so neither "the line above" nor "up to the first blank" finds
  // the sentence reliably.
  const body: string[] = [];
  for (let seen = 0; i >= 0 && seen < MAX_BODY_LINES; i--, seen++) {
    const line = lines[i].trim();
    if (CHROME_RE.test(line) && line) break;
    if (OPTION_RE.test(line)) break;
    // The bullet the CLI puts on a prompt is not part of what it asked.
    body.unshift(line.replace(/^[●✻※⏺]\s*/, ""));
  }
  const paragraphs = body
    .join("\n")
    .split(/\n\s*\n/)
    .map((para) => para.split("\n").join(" ").trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;

  // The part that actually asks something, when one of them does — the trust
  // dialog puts a note and a documentation link between its question and its
  // options, and the nearest line is the link. Failing that the longest
  // paragraph, which is the sentence rather than the heading above it.
  const asking = paragraphs.filter((para) => para.includes("?")).at(-1);
  const question = (asking ?? paragraphs.reduce((a, b) => (b.length > a.length ? b : a))).slice(
    0,
    MAX_QUESTION,
  );
  // One box makes it a multi-select; the escape hatches under the real answers
  // ("type something", "chat about this") never carry one.
  const multiSelect = options.some((o) => o.checked !== undefined);
  return { question, multiSelect, options };
}

/**
 * The permission mode claude prints on its status line, or null when the pane
 * shows none.
 *
 * The same bet as everything above it, read off the same pane: the CLI draws
 * that line as `<symbol> <indicator> on`, and the indicators below are its full
 * set. An unknown one is null, which is what the chip showed before this
 * existed.
 *
 * Why the pane rather than the transcript, which carries a permission-mode
 * entry of its own: that entry is written per turn, so it says which mode the
 * last turn ran in, not which mode the session is in now. Cycling the mode
 * between turns changes nothing on disk until the agent next speaks — and a
 * chip that does not move when tapped is a chip that gets tapped twice.
 *
 * Only the last lines are read. The status line is the bottom of the pane, and
 * further up is scrollback where an earlier screen's mode would win.
 */
const MODES: { re: RegExp; label: string }[] = [
  { re: /bypass permissions on\b/i, label: "bypass" },
  { re: /don['’]t ask on\b/i, label: "don't ask" },
  { re: /accept edits on\b/i, label: "accept edits" },
  { re: /auto mode on\b/i, label: "auto" },
  { re: /plan mode on\b/i, label: "plan" },
  { re: /manual mode on\b/i, label: "manual" },
];

/** How far up from the bottom the status line can be. */
const MODE_TAIL_LINES = 4;

export function parseMode(pane: string): string | null {
  const lines = pane.split("\n").map((l) => l.replace(/\s+$/, ""));
  const tail = lines.filter(Boolean).slice(-MODE_TAIL_LINES);
  for (let i = tail.length - 1; i >= 0; i--) {
    const hit = MODES.find((m) => m.re.test(tail[i]));
    if (hit) return hit.label;
  }
  return null;
}

/**
 * Whether the agent is mid-turn, and what it says it is doing.
 *
 * The status a session carries is written by the hooks and only distinguishes
 * "needs you" from everything else — an agent thinking hard and an agent sat at
 * an empty prompt are both "running". In the terminal you can see which; in the
 * chat you could not, and "is it working or is it stuck" is the question being
 * asked of that screen most often.
 *
 * The pane knows. Claude prints "esc to interrupt" on its status line while a
 * turn is running and never when one is not, so that is the signal — the one
 * bit that matters. The verb above it is decoration: nice when it parses,
 * absent without consequence when it does not.
 */
const BUSY_RE = /esc to interrupt/i;

/**
 * `✻ Building the live prompt strip… (35m 21s · ↓ 85.8k tokens)`
 *
 * The ellipsis and the timer in brackets are both required, which is what keeps
 * this off the line the CLI draws when a turn *finishes* — that one reads
 * `✻ Sautéed for 1m 21s · done 11:06 AM` and has neither.
 */
const ACTIVITY_RE = /^\s*[✻✽✢✶●*·※]\s+(\S.*?)…\s*\(/;

export function parseActivity(pane: string): { busy: boolean; doing: string | null } {
  const lines = pane.split("\n").map((l) => l.replace(/\s+$/, ""));
  // Blanks dropped before the tail is taken, the same as `parseMode`: a real
  // capture is the pane's full height, so the last lines of one are the empty
  // rows under the composer rather than the status line.
  const busy = lines
    .filter(Boolean)
    .slice(-MODE_TAIL_LINES - 2)
    .some((l) => BUSY_RE.test(l));
  if (!busy) return { busy: false, doing: null };
  // Nearest first: the CLI redraws this line in place, so the last one on the
  // pane is the turn that is running now.
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = ACTIVITY_RE.exec(lines[i]);
    if (m) return { busy, doing: m[1].slice(0, MAX_QUESTION) };
  }
  return { busy, doing: null };
}
