import { useEffect, useState } from "react";
import type { Session, SessionPrompt, TuiPrompt } from "../../../../shared/api";
import { api } from "../../api";

/**
 * What the session is being asked right now, and the buttons to answer it.
 *
 * Everything else in this view comes from the transcript, which is stable and
 * outlives the session. This does not: a dialog is drawn on the pane and never
 * written down, so the only way to know a session is blocked — or what it is
 * blocked on — is to look at what the terminal is showing.
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
  ask,
  onAnswer,
  onSend,
  sending,
}: {
  session: Session;
  /** True when a question card is on screen with no answer yet. */
  ask: boolean;
  /** Presses one option's number. Sends no Return — see ChatPane's `answer`. */
  onAnswer: (digit: string) => Promise<void> | void;
  /** Types a line, for the dialogs this cannot read. */
  onSend: (value: string) => Promise<void> | void;
  sending: boolean;
}) {
  const [prompt, setPrompt] = useState<TuiPrompt | null>(null);
  const waiting = session.status === "waiting";
  // Two reasons to look, and both are needed. A permission prompt flips the
  // session to waiting through its hook; a question does not — every tool call
  // writes "running" first — so an unanswered card is the other half of it.
  const worthLooking = session.status !== "done" && (waiting || ask);

  useEffect(() => {
    if (!worthLooking) {
      setPrompt(null);
      return;
    }
    let stopped = false;
    async function look() {
      try {
        const res = await api<SessionPrompt>(`/api/sessions/${session.id}/prompt`);
        if (!stopped) setPrompt(res.prompt);
      } catch {
        // A pane that cannot be read is not a pane that is asking anything.
        if (!stopped) setPrompt(null);
      }
    }
    void look();
    const timer = setInterval(() => {
      if (!document.hidden) void look();
    }, 2_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [session.id, worthLooking]);

  if (session.status === "done") return null;

  if (prompt) {
    return (
      <div className="flex flex-none flex-col gap-2 border-t border-wait/40 bg-wait/5 px-3.5 py-2.5">
        <p className="text-[13px] text-wait">{prompt.question}</p>
        <div className="flex flex-wrap gap-1.5">
          {prompt.options.map((o) => (
            <button
              key={o.number}
              // The number alone is what the CLI is listening for: watched
              // against a real dialog, the keypress submits and a Return after
              // it would go to the composer instead.
              onClick={() => void onAnswer(String(o.number))}
              disabled={sending}
              className={`tap max-w-full truncate rounded-md border px-2.5 py-1 text-left font-mono text-[12px] disabled:opacity-50 ${
                o.selected ? "border-accent text-accent" : "border-line text-muted"
              }`}
            >
              {o.number}. {o.label}
            </button>
          ))}
        </div>
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
