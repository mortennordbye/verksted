import type { Terminal as Xterm } from "@xterm/xterm";

/**
 * What the terminal reads back off its own screen: a sign-in link to surface
 * as a tap target, and the permission mode the status line shows. Pure reads
 * of the buffer, kept apart from the component that draws it.
 */

/**
 * Agent sign-in URLs. Selecting and copying these off a phone terminal is
 * painful; we surface a tap target.
 *
 * By host, not by a word in the path (F-09): any URL with `login` or `verify`
 * in it used to raise the bar, so a file called login.ts in a diff, or a docs
 * link in an agent's prose, was a sign-in link that could not be got rid of.
 * The hosts are the identity providers of the agents this app runs — claude's
 * two, codex's, antigravity's Google, and gh's device flow — and a provider
 * moving is a line here, not a missed sign-in.
 */
export const AUTH_URL_RE =
  /https?:\/\/(?:(?:claude\.ai|console\.anthropic\.com)\/oauth\/|auth\.openai\.com\/|accounts\.google\.com\/|github\.com\/login\/)\S*/i;

// A wrapped URL continuation row is one unbroken run of URL characters — no
// spaces, since that's the only thing wrapping split. This is the reconnection
// signal, and unlike "row is full" it never depends on the wrap width matching
// the terminal's current cols (which a keyboard-driven resize can desync).
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * Most recent auth URL visible in the terminal, or null. Only the last ~400
 * rows are scanned — the sign-in URL is always the freshest thing on screen.
 *
 * A long URL is split across rows by xterm's wrapping or by the agent TUI
 * hard-wrapping. We find the row the URL starts on, then — only if it ran to
 * that row's end — keep appending following rows while each is a pure run of
 * URL characters. The first row that isn't (a blank line, prose, a prompt)
 * ends it. No reference to cols, so a resize between render and scan can't
 * truncate the result.
 */
export function findAuthUrl(term: Xterm): string | null {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - 400);
  const rows: string[] = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    rows.push(line ? line.translateToString(true) : ""); // right-trimmed
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i].match(AUTH_URL_RE);
    if (!m) continue;
    let url = m[0];
    // Continuation rows exist only if the URL reached this row's end.
    if (rows[i].indexOf(m[0]) + m[0].length === rows[i].length) {
      for (let j = i + 1; j < rows.length && URL_CHARS_RE.test(rows[j]); j++) {
        url += rows[j];
      }
    }
    return url;
  }
  return null;
}

// shift+tab: claude's permission-mode toggle.
export const MODE_SEQ = "\x1b[Z";

/**
 * The permission mode as the agent prints it on its status line — the row the
 * on-screen keyboard covers, which is the whole reason for the chip.
 *
 * claude renders that line as `<symbol> <indicator> on`; the indicators below
 * are its full set, read off the CLI bundle rather than guessed. An unknown
 * one just leaves the chip reading "mode", same as before it could detect any.
 */
export const MODES: { re: RegExp; label: string; tone: string }[] = [
  { re: /bypass permissions on\b/i, label: "bypass", tone: "border-fail text-fail" },
  { re: /don['’]t ask on\b/i, label: "don't ask", tone: "border-fail text-fail" },
  { re: /accept edits on\b/i, label: "accept edits", tone: "border-run text-run" },
  { re: /auto mode on\b/i, label: "auto", tone: "border-run text-run" },
  { re: /plan mode on\b/i, label: "plan", tone: "border-accent text-accent" },
  { re: /manual mode on\b/i, label: "manual", tone: "border-line text-muted" },
];

/**
 * Permission mode currently shown on the terminal's status line, or null when
 * no line matches. Only the viewport is scanned — never the scrollback, where a
 * stale mode line from an earlier screen would win.
 */
export function findMode(term: Xterm): (typeof MODES)[number] | null {
  const buf = term.buffer.active;
  for (let i = buf.baseY + term.rows - 1; i >= buf.baseY; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    const hit = MODES.find((m) => m.re.test(text));
    if (hit) return hit;
  }
  return null;
}
