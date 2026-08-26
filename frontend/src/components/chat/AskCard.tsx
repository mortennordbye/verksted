import type { ChatAsk } from "../../../../shared/api";

/**
 * A question the agent put to the person, drawn as the CLI draws it.
 *
 * Every part of this — the header, the options, the descriptions, which of them
 * was picked — is written to the transcript, so it is rebuilt rather than
 * scraped. That is what lets it read the same on a session that ended weeks ago
 * as it did on the day, and it is why the card does not depend on the terminal
 * being open, or on the session being alive at all.
 *
 * Answering is not this component's job. What the transcript cannot say is
 * whether the CLI is drawing this dialog right now, and that is the one thing
 * you need to know before sending a keystroke at it.
 */
export default function AskCard({ ask }: { ask: ChatAsk }) {
  return (
    <div className="flex flex-col gap-3 rounded-[14px] border border-line bg-surface-2/50 p-3">
      {ask.questions.map((q, qi) => (
        <div key={qi} className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            {q.header && (
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide uppercase ${
                  ask.answered ? "border-line text-faint" : "border-wait/50 text-wait"
                }`}
              >
                {q.header}
              </span>
            )}
            {q.multiSelect && <span className="font-mono text-[10px] text-faint">pick any</span>}
          </div>
          <p className="text-[14px] font-medium text-text">{q.question}</p>

          {/* Answered: the options collapse to what was actually chosen, which
              is the only part anybody rereads. */}
          {ask.answered ? (
            <ul className="flex flex-col gap-1">
              {(q.chosen.length ? q.chosen : ["(dismissed)"]).map((label, i) => (
                <li key={i} className="flex gap-2 text-[13px] text-muted">
                  <span className="flex-none text-run">✓</span>
                  <span className="min-w-0">{label}</span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {q.options.map((o, i) => (
                <li
                  key={i}
                  className="rounded-lg border border-line bg-surface px-2.5 py-2 text-[13px]"
                >
                  <p className="font-medium text-text">{o.label}</p>
                  {o.description && <p className="mt-0.5 text-muted">{o.description}</p>}
                  {o.preview && (
                    <pre className="mt-1.5 overflow-x-auto rounded border border-line bg-term p-2 font-mono text-[11px] text-muted">
                      {o.preview}
                    </pre>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
