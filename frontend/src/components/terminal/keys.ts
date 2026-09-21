/**
 * Special keys for touch screens, where the on-screen keyboard lacks them.
 *
 * `row` is which tier the key sits in. Row 1 is what you press while answering
 * an agent: it is always on screen and always fits one line. Row 2 is
 * everything else, one tap away in the `more` sheet.
 *
 * The split exists because these keys compete with the terminal for a phone
 * screen. They were one horizontal scroller of twenty-five controls, which put
 * two thirds of them off the edge behind a drag gesture nothing advertised;
 * then two stacked tiers, which is how four rows of keys came to sit above a
 * terminal with two lines left. A sheet costs the same tap the tier did and
 * takes none of the terminal.
 */
export const KEYS: { label: string; seq: string; title?: string; row: 1 | 2 }[] = [
  { label: "esc", seq: "\x1b", row: 1 },
  // Permission prompts are the single most common thing to answer from a
  // phone, and both answers are one tap away here.
  { label: "y", seq: "y", title: "answer yes", row: 1 },
  { label: "n", seq: "n", title: "answer no", row: 1 },
  // carriage return — submits the claude prompt / a pasted sign-in code
  { label: "enter", seq: "\r", row: 1 },
  { label: "↑", seq: "\x1b[A", row: 1 },
  { label: "^C", seq: "\x03", row: 1 },
  { label: "tab", seq: "\t", row: 2 },
  // A newline without submitting: how you write a second line into a claude
  // prompt, and unreachable from an on-screen keyboard otherwise.
  { label: "⏎+", seq: "\x1b\r", title: "newline without sending", row: 2 },
  { label: "/", seq: "/", row: 2 },
  { label: "↓", seq: "\x1b[B", row: 2 },
  { label: "←", seq: "\x1b[D", row: 2 },
  { label: "→", seq: "\x1b[C", row: 2 },
  { label: "^D", seq: "\x04", title: "end of input", row: 2 },
  { label: "^R", seq: "\x12", title: "reverse history search", row: 2 },
  { label: "^L", seq: "\x0c", title: "clear screen", row: 2 },
  { label: "home", seq: "\x1b[H", title: "start of line", row: 2 },
  { label: "end", seq: "\x1b[F", title: "end of line", row: 2 },
];

// Toolbar key styling. Tap feedback matters more here than it looks: on a phone
// these keys are the whole keyboard, and a press that leaves no mark reads as a
// press that didn't land. :active covers the finger-down moment; `flash` holds
// the same look for a moment after release, which is what makes a quick tap
// visible at all.
const KEY_BOX =
  "flex-none items-center justify-center rounded-md border px-2 py-1 font-mono text-[12px] transition-colors";
/** In the `more` sheet, where there is room to be 44px tall, so it is. */
export const KEY = `tap ${KEY_BOX}`;
/**
 * In the bar, where 44px of box is 16px of terminal: 44px to a finger, 28px to
 * the layout. `tap-hit`'s overlay overhangs the box by 8px a side, so the bar
 * needs a row gap wider than that — see the bar itself, and theme.css.
 */
export const KEY_TIGHT = `tap-hit ${KEY_BOX}`;
export const KEY_PRESS = "active:border-accent active:bg-accent/25 active:text-accent";
export const KEY_IDLE = "border-line text-muted";
export const KEY_LIT = "border-accent bg-accent/25 text-accent";
