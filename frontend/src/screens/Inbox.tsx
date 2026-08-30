import { useState } from "react";
import { Link } from "react-router";
import type {
  MaintainerIssue,
  Memory,
  ScheduleRun,
  Session,
  SessionUsage,
  SessionWork,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import { ReviewMark, StatusChip } from "../components/StatusChip";
import { tokens, usd } from "../components/UsagePanel";
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

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/**
 * What the repo has to show for a run, in one line under its sign-off. A run
 * that said "ok: tidied the PRs" and left nothing behind is the case worth
 * seeing, so "no changes" is stated rather than left blank.
 */
/** "41k tokens · $0.90": what a run took, and what that would have cost. */
function tokensLabel(u: SessionUsage): string {
  const label = `${tokens(u.input + u.output + u.cacheRead + u.cacheWrite)} tokens`;
  return u.costUsd == null ? label : `${label} · ${usd(u.costUsd)}`;
}

function workLabel(w: SessionWork): string {
  const parts: string[] = [];
  if (w.commits) parts.push(plural(w.commits, "commit"));
  if (w.files) parts.push(plural(w.files, "file"));
  if (w.dirty) parts.push(`${w.dirty} uncommitted`);
  // Work that has not left the volume is the part worth flagging: no remote has
  // it, so the PVC is the only copy.
  if (w.unpushed) parts.push(`${plural(w.unpushed, "commit")} unpushed`);
  else if (w.unpushed === null && w.commits) parts.push("no upstream");
  if (parts.length === 0) return `no changes on ${w.branch}`;
  return `${parts.join(" · ")} on ${w.branch}`;
}

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
  const { data: queue } = usePoll<MaintainerIssue[]>("/api/maintainer/queue", 60_000);
  const { data: proposed, refresh: refreshProposed } = usePoll<{ proposals: Memory[] }>(
    "/api/memory/proposed",
    30_000,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");
  /** A run's review, read off the session it started — the runs list has no
   *  reason to carry it, and the session list is already on this screen. */
  const reviewOf = (sessionId: string | null) =>
    sessions?.find((s) => s.id === sessionId)?.review ?? null;
  const proposals = proposed?.proposals ?? [];
  // Proposals count: they are the one thing here that arrives with nothing to
  // announce it, and a queue nobody looks at is a learning loop that stalls at
  // the review step. Lighter than blocked work, but it does want you.
  const needsYou =
    waiting.length +
    proposals.length +
    (runs ?? []).filter((r) => r.outcome === "attention" || r.outcome === "failed").length;

  async function review(slug: string, keep: boolean) {
    if (busy) return;
    setBusy(slug);
    try {
      await api(keep ? `/api/memory/proposed/${slug}/keep` : `/api/memory/proposed/${slug}`, {
        method: keep ? "POST" : "DELETE",
      });
      refreshProposed();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <TopBar crumb={[{ label: "inbox" }]} />
      <main className="mx-auto max-w-[900px] px-[18px] pt-[22px] pb-[calc(80px+env(safe-area-inset-bottom))] min-[800px]:pb-[60px]">
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
          Agents blocked on a decision, memories waiting to be kept or dropped, then every firing of
          every schedule. A run signs off with one line; that line is what the phone got.
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

        {/* The gate. Nothing harvested reaches a session until it is kept here,
            which is the only thing standing between an automatic memory and a
            wrong fact quietly degrading every later session. */}
        {proposals.length > 0 && (
          <>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Proposed memories
            </div>
            <div className="mb-1.5 text-[13px] text-muted">
              Noticed in sessions that ended recently. Kept ones are told to every agent in every
              repo from then on; dropped ones leave no trace.
            </div>
            <div className="mb-7 flex flex-col gap-2">
              {proposals.map((p) => (
                <div
                  key={p.slug}
                  className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
                >
                  <div className="text-[13.5px]">
                    {p.scope !== "global" && <span className="text-faint">In {p.scope}: </span>}
                    {p.text}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2.5">
                    <StatusChip kind="idle" label={p.type} />
                    {/* Provenance is the answer to "why does it think that?",
                        and this is the moment the question gets asked. */}
                    {p.source && (
                      <span className="font-mono text-[11px] text-faint">{p.source}</span>
                    )}
                    <span className="ml-auto flex gap-2">
                      <button
                        onClick={() => review(p.slug, true)}
                        disabled={busy !== null}
                        className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
                      >
                        keep
                      </button>
                      <button
                        onClick={() => review(p.slug, false)}
                        disabled={busy !== null}
                        className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
                      >
                        drop
                      </button>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {queue && queue.length > 0 && (
          <>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Maintainer queue
            </div>
            {/* The queue is the repos' own issues, so a row opens on GitHub:
                that is where an issue is written, relabelled or closed. */}
            <div className="mb-8 flex flex-col gap-2">
              {queue.map((i) => (
                <a
                  key={`${i.project}#${i.number}`}
                  href={i.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5 hover:border-line-strong"
                >
                  <StatusChip
                    kind={
                      i.state === "in-progress" ? "run" : i.state === "blocked" ? "wait" : "idle"
                    }
                    label={i.state}
                  />
                  <span className="font-mono text-[11px] text-faint">{i.project}</span>
                  <span className="min-w-0 flex-1 truncate text-[12.5px]">
                    <span className="font-mono text-faint">#{i.number}</span> {i.title}
                  </span>
                  {i.tier && (
                    <span className="font-mono text-[11px] text-faint">tier:{i.tier}</span>
                  )}
                </a>
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
                {r.stage && <span className="font-mono text-[11px] text-faint">{r.stage}</span>}
                {/* An assistant run belongs to no repo, so there is nowhere to
                    link: what it is gets said instead. */}
                {r.kind === "assistant" ? (
                  <span className="font-mono text-[11px] text-faint">the assistant</span>
                ) : (
                  <Link
                    to={`/p/${r.project}`}
                    className="font-mono text-[11px] text-faint hover:text-accent"
                  >
                    {r.project}
                  </Link>
                )}
                <span className="ml-auto font-mono text-[11px] text-faint">{agoLabel(r.at)}</span>
              </div>
              <div className="mt-1.5 break-words text-[12.5px] text-muted">
                {r.report ?? r.error ?? "no sign-off"}
              </div>
              {r.work && (
                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="font-mono text-[11px] text-faint">
                    {workLabel(r.work)}
                    {r.usage && ` · ${tokensLabel(r.usage)}`}
                  </span>
                  {/* A night that has already been read says so here, so the
                      inbox is a list of what is still outstanding. */}
                  {reviewOf(r.sessionId) && (
                    <ReviewMark review={reviewOf(r.sessionId)!} total={r.work.files} />
                  )}
                </div>
              )}
              {r.sessionId && (
                <div className="mt-1.5 flex flex-wrap gap-3">
                  <Link
                    to={`/s/${r.sessionId}`}
                    className="font-mono text-[11px] text-muted hover:text-accent"
                  >
                    open {r.sessionId} →
                  </Link>
                  {/* The counts above say something happened; this is the way to
                      what it was, without opening a terminal on a phone. */}
                  {(r.work?.commits ?? 0) > 0 && (
                    <Link
                      to={`/s/${r.sessionId}?side=changes`}
                      className="font-mono text-[11px] text-muted hover:text-accent"
                    >
                      review the changes →
                    </Link>
                  )}
                </div>
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
      <Tabs />
    </>
  );
}
