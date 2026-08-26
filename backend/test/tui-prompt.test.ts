import { describe, expect, it } from "vitest";
import { parsePrompt } from "../src/tui-prompt.js";

/**
 * Reading a dialog off the pane.
 *
 * Every fixture here was captured from a real session on the bench rather than
 * written to fit the parser, which is the only thing that makes a test of a
 * scraper worth anything. When the CLI changes how it draws, these are what
 * should be recaptured first.
 *
 * The important cases are the negative ones. This parser exists to decide
 * whether to put buttons in front of somebody that send keystrokes to a live
 * agent, so being wrong in the "yes it is asking" direction is much more
 * expensive than being wrong in the other.
 */

/** vk-logeverylift-6, blocked on the resume dialog. */
const RESUME = `※ recap: Goal was a high-value new spec: I wrote docs/specs/set-write-path.md
  (54 rules) covering set logging and offline durability, found five
  divergences, logged them in BACKLOG.md, and verify passed.

────────────────────────────────────────────────────────────────────────────────

  This session is 1h 19m old and 161.8k tokens.

  Resuming the full session will consume a substantial portion of your usage
  limits. We recommend resuming from a summary.

  ❯ 1. Resume from summary (recommended)
    2. Resume full session as-is
    3. Don't ask me again

  Enter to confirm · Esc to cancel
`;

/**
 * vk-headroom-2. A numbered list, and the session is not waiting on it at all:
 * the survey is optional and there is a half-typed message in the composer
 * underneath.
 */
const SURVEY = `✻ Sautéed for 1m 21s · done 11:06 AM

● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss

────────────────────────────────────────────────────────────────
❯ fix the html lang thing too
────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents
`;

/** vk-verksted-15, working. Nothing is being asked. */
const WORKING = `* Building the live prompt strip… (35m 21s · ↓ 85.8k tokens)
  ⎿  ✔ Stage 3: images
     ◼ Stage 5: the live prompt strip

───────────────────────────────────────────────────────────────
❯
───────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle) · esc to interrupt
`;

describe("parsePrompt", () => {
  it("reads a blocking dialog, and which option the cursor is on", () => {
    const prompt = parsePrompt(RESUME);
    expect(prompt).not.toBeNull();
    // Wrapped to the pane width, so the question is the paragraph rather than
    // the last line of it.
    expect(prompt!.question).toBe(
      "Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary.",
    );
    expect(prompt!.options).toEqual([
      { number: 1, label: "Resume from summary (recommended)", selected: true },
      { number: 2, label: "Resume full session as-is", selected: false },
      { number: 3, label: "Don't ask me again", selected: false },
    ]);
  });

  /** The trust dialog, captured from a fresh claude in a scratch directory. */
  const TRUST = `───────────────────────────────────────────────────────────────────

 Accessing workspace:

 /tmp/vk-tui-probe

 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or
 work from your team). If not, take a moment to review what's in this folder first.

 Claude Code'll be able to read, edit, and execute files here.

 Security guide

 ❯ 1. Yes, I trust this folder
   2. No, exit

 Enter to confirm · Esc to cancel
`;

  it("finds the sentence that asks, not the link sitting next to the options", () => {
    const prompt = parsePrompt(TRUST);
    expect(prompt).not.toBeNull();
    // Between the question and the options sit a note and a documentation link,
    // so the nearest line above the options is "Security guide".
    expect(prompt!.question).toContain("Quick safety check");
    expect(prompt!.question).not.toBe("Security guide");
    expect(prompt!.options).toEqual([
      { number: 1, label: "Yes, I trust this folder", selected: true },
      { number: 2, label: "No, exit", selected: false },
    ]);
  });

  /**
   * An AskUserQuestion, captured live. The hardest shape: every option carries
   * a description beneath it, and a rule is drawn between the real answers and
   * the escape hatches under them.
   */
  const ASK = ` \u2610 Shed colour

What colour should the shed be painted?

\u276f 1. Falu red
     Classic Nordic barn red — traditional, hides weathering well, pairs with white trim.
  2. Charcoal grey
     Modern and understated; recedes into the garden and shows less dirt than light tones.
  3. Sage green
     Soft muted green that blends with planting and looks less industrial than grey.
  4. Type something.
${"─".repeat(60)}
  5. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
`;

  it("reads a question the agent asked, descriptions and all", () => {
    const prompt = parsePrompt(ASK);
    expect(prompt).not.toBeNull();
    expect(prompt!.question).toBe("What colour should the shed be painted?");
    expect(prompt!.options.map((o) => [o.number, o.label])).toEqual([
      [1, "Falu red"],
      [2, "Charcoal grey"],
      [3, "Sage green"],
      [4, "Type something."],
      [5, "Chat about this"],
    ]);
    expect(prompt!.options[0].selected).toBe(true);
    // The descriptions are the CLI's, not labels — they must not become buttons.
    expect(prompt!.options.some((o) => o.label.includes("Classic Nordic"))).toBe(false);
  });

  it("does not mistake the survey for something the session is waiting on", () => {
    // It is a numbered list, and it is answerable, and the session is still
    // working with a message half-typed under it. Buttons here would say a
    // session is stuck when it is not.
    expect(parsePrompt(SURVEY)).toBeNull();
  });

  it("says nothing about a session that is simply working", () => {
    expect(parsePrompt(WORKING)).toBeNull();
  });

  it("says nothing about an empty or garbage pane", () => {
    expect(parsePrompt("")).toBeNull();
    expect(parsePrompt("\n\n\n")).toBeNull();
    expect(parsePrompt("just some output\nand some more")).toBeNull();
  });

  it("will not turn a numbered list the agent printed into buttons", () => {
    // The shape that would false-positive: prose that happens to be numbered.
    // It is saved by needing to be the last thing on the pane, under a caption.
    const printed = `Here is what I would do:

  1. Fix the probe timeout
  2. Raise the memory limit
  3. Ship it

──────────────────────────────────
❯
──────────────────────────────────
  ⏵⏵ auto mode on
`;
    expect(parsePrompt(printed)).toBeNull();
  });

  it("needs the numbers to actually run in order", () => {
    const scattered = `Which one?

  1. first
  3. third

  Enter to confirm
`;
    expect(parsePrompt(scattered)).toBeNull();
  });

  it("needs more than one option, since one number is a list item", () => {
    expect(parsePrompt("Something\n\n  1. only me\n\n  Enter to confirm\n")).toBeNull();
  });

  it("refuses a pane offering more options than a dialog ever has", () => {
    const many = ["A question"]
      .concat(Array.from({ length: 14 }, (_, i) => `  ${i + 1}. option ${i + 1}`))
      .concat(["", "  Enter to confirm"])
      .join("\n");
    expect(parsePrompt(many)).toBeNull();
  });

  it("does not answer with a dialog that has no question above it", () => {
    expect(parsePrompt("  1. yes\n  2. no\n\n  Enter to confirm\n")).toBeNull();
  });
});
