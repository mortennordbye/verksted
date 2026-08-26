import type { Session, TuiPrompt } from "../../../../shared/api";

/**
 * What the session is being asked right now, and the buttons to answer it.
 *
 * Everything else in this view comes from the transcript, which is stable and
 * outlives the session. This does not: a dialog is drawn on the pane and never
 * written down, so the only way to know a session is blocked — or what it is
 * blocked on — is to look at what the terminal is showing.
 *
 * The scrape itself belongs to ChatPane, which needs the same pane for the
 * permission mode. One capture per poll rather than one per thing read off it.
 *
 * The two halves are kept apart on purpose. The question card above renders
 * from the transcript and is always right about *what was asked*; this strip
 * renders whatever the pane parser found and is the only thing that claims to
 * know *how to answer it now*. When the parse comes back empty the strip falls
 * back to what this pane showed before any of it existed, and the card is still
 * there to read. Nothing breaks, a button is just missing.
 *
 * It is also why the labels here are the CLI's own words rather than the
 * card's: what is drawn is what will be pressed.
 */
export default function LivePrompt({
  session,
  prompt,
  onAnswer,
  onKey,
  onSend,
  sending,
}: {
  session: Session;
  /** What the pane is drawing, or null when it is drawing no dialog. */
  prompt: TuiPrompt | null;
  /** Presses one option's number. Sends no Return — see ChatPane's `answer`. */
  onAnswer: (digit: string) => Promise<void> | void;
  /** Presses a named key, for moving on from a question with several answers. */
  onKey: (key: "right") => Promise<void> | void;
  /** Types a line, for the dialogs this cannot read. */
  onSend: (value: string) => Promise<void> | void;
  sending: boolean;
}) {
  const waiting = session.status === "waiting";

  if (session.status === "done") return null;

  if (prompt) {
    return (
      <div className="flex flex-none flex-col gap-2 border-t border-wait/40 bg-wait/5 px-3.5 py-2.5">
        <p className="text-[13px] text-wait">{prompt.question}</p>
        <div className="flex flex-wrap gap-1.5">
          {prompt.options.map((o) => (
            <button
              key={o.number}
              // The number alone, either way. On a single-select it answers
              // outright; on a multi-select it ticks a box and the dialog stays
              // open. Both were watched against a real one. What is never sent
              // is Return: it does not submit, it toggles whatever the cursor
              // happens to be sitting on.
              onClick={() => void onAnswer(String(o.number))}
              disabled={sending}
              aria-pressed={prompt.multiSelect ? o.checked === true : undefined}
              className={`tap max-w-full truncate rounded-md border px-2.5 py-1 text-left font-mono text-[12px] disabled:opacity-50 ${
                o.checked
                  ? "border-run/60 text-run"
                  : o.selected && !prompt.multiSelect
                    ? "border-accent text-accent"
                    : "border-line text-muted"
              }`}
            >
              {prompt.multiSelect && o.checked !== undefined && (
                <span className="mr-1.5">{o.checked ? "☑" : "☐"}</span>
              )}
              {o.number}. {o.label}
            </button>
          ))}
        </div>
        {/* Ticking boxes does not answer anything on its own. The CLI moves
            from the boxes to a review screen, and that screen is an ordinary
            numbered dialog — so the next thing this strip draws is its own
            "submit answers" button, from the same parse. */}
        {prompt.multiSelect && (
          <button
            onClick={() => void onKey("right")}
            disabled={sending}
            className="tap self-start rounded-md border border-accent px-2.5 py-1 font-mono text-[12px] text-accent disabled:opacity-50"
          >
            review and submit →
          </button>
        )}
      </div>
    );
  }

  if (waiting) {
    // Blocked on something the parser did not recognise. Saying so beats saying
    // nothing, and the terminal is one tap away.
    return (
      <div className="flex flex-none flex-wrap items-center gap-2 border-t border-wait/40 bg-wait/5 px-3.5 py-2 font-mono text-[12px] text-wait">
        <span className="min-w-0 flex-1">it is waiting for you</span>
        <button
          onClick={() => void onSend("y")}
          disabled={sending}
          className="tap rounded-md border border-run/50 px-2.5 py-1 text-run disabled:opacity-50"
        >
          yes
        </button>
        <button
          onClick={() => void onSend("n")}
          disabled={sending}
          className="tap rounded-md border border-fail/50 px-2.5 py-1 text-fail disabled:opacity-50"
        >
          no
        </button>
      </div>
    );
  }

  return null;
}
