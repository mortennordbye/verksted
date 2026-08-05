import { Link } from "react-router";
import type { ScheduleRun, Session } from "../../../shared/api";
import { agoLabel, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { StatusChip } from "../components/StatusChip";
import WaitingSession from "../components/WaitingSession";

/** The badge for a run's outcome. Only "attention" and "failed" want the eye. */
const OUTCOME: Record<ScheduleRun["outcome"], { kind: "run" | "wait" | "fail" | "idle" }> = {
  ok: { kind: "run" },
  attention: { kind: "wait" },
  failed: { kind: "fail" },
  blocked: { kind: "idle" },
  running: { kind: "run" },
  done: { kind: "idle" },
};

/**
 * Everything that wants you, in one place.
 *
 * Two things belong here and used to be reachable only by hunting: agents that
 * are blocked on a decision right now, and what the schedules did while you
 * were not looking. Both answer the same question — "is anything waiting on
 * me?" — and a phone should be able to answer it from one screen, and act on
 * it without opening a terminal.
 *
 * Live sessions come first because they are blocking work; the runs below are
 * history.
 */
export default function Inbox() {
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 8_000);
  const { data: runs } = usePoll<ScheduleRun[]>("/api/runs", 15_000);
  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");
  const needsYou =
    waiting.length +
    (runs ?? []).filter((r) => r.outcome === "attention" || r.outcome === "failed").length;

  return (
    <>
      <TopBar back="/" crumb={["inbox"]} />
      <main className="mx-auto max-w-[900px] px-[18px] pt-[22px] pb-[60px]">
        <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
          Inbox
        </div>
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">
          {runs === null && sessions === null
            ? "…"
            : needsYou
              ? `${needsYou} need${needsYou === 1 ? "s" : ""} you`
              : "nothing needs you"}
        </h1>
        <div className="mb-6 text-sm text-muted">
          Agents blocked on a decision, then every firing of every schedule. A run signs off with
          one line; that line is what the phone got.
        </div>

        {waiting.length > 0 && (
          <>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Waiting on you
            </div>
            <div className="mb-7 flex flex-col gap-2">
              {waiting.map((s) => (
                <WaitingSession key={s.id} session={s} />
              ))}
            </div>
          </>
        )}

        <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Scheduled runs
        </div>
        <div className="flex flex-col gap-2">
          {(runs ?? []).map((r) => (
            <div
              key={`${r.scheduleId}-${r.at}`}
              className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <StatusChip kind={OUTCOME[r.outcome].kind} label={r.outcome} />
                <span className="font-mono text-[12.5px]">{r.schedule}</span>
                <Link
                  to={`/p/${r.project}`}
                  className="font-mono text-[11px] text-faint hover:text-accent"
                >
                  {r.project}
                </Link>
                <span className="ml-auto font-mono text-[11px] text-faint">{agoLabel(r.at)}</span>
              </div>
              <div className="mt-1.5 text-[12.5px] text-muted">
                {r.report ?? r.error ?? "no sign-off"}
              </div>
              {r.sessionId && (
                <Link
                  to={`/s/${r.sessionId}`}
                  className="mt-1.5 inline-block font-mono text-[11px] text-muted hover:text-accent"
                >
                  open {r.sessionId} →
                </Link>
              )}
            </div>
          ))}
          {runs?.length === 0 && (
            <div className="font-mono text-[12.5px] text-faint">
              nothing has run yet — add a schedule in settings
            </div>
          )}
        </div>
      </main>
    </>
  );
}
