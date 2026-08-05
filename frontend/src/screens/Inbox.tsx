import { Link } from "react-router";
import type { ScheduleRun } from "../../../shared/api";
import { agoLabel, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { StatusChip } from "../components/StatusChip";

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
 * What the schedules did while you were not looking, newest first. The point of
 * the screen is to answer "anything overnight?" without opening a terminal:
 * every run is one line, and its own sign-off is the line.
 */
export default function Inbox() {
  const { data: runs } = usePoll<ScheduleRun[]>("/api/runs", 15_000);
  const needsYou = (runs ?? []).filter(
    (r) => r.outcome === "attention" || r.outcome === "failed",
  ).length;

  return (
    <>
      <TopBar back="/" crumb={["inbox"]} />
      <main className="mx-auto max-w-[900px] px-[18px] pt-[22px] pb-[60px]">
        <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
          Inbox · scheduled runs
        </div>
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">
          {runs === null
            ? "…"
            : needsYou
              ? `${needsYou} need${needsYou === 1 ? "s" : ""} you`
              : "nothing needs you"}
        </h1>
        <div className="mb-6 text-sm text-muted">
          Every firing of every schedule, newest first. A run signs off with one line;
          that line is what the phone got.
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
                <span className="ml-auto font-mono text-[11px] text-faint">
                  {agoLabel(r.at)}
                </span>
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
