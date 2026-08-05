import { useState } from "react";
import type { RunLog, WorkflowRun, WorkflowRunDetail } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import { StatusChip, StatusDot } from "./StatusChip";
import Sheet from "./Sheet";
import CodeOverlay from "./CodeOverlay";

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** The chip for a run: unfinished runs are amber, then the conclusion decides. */
function chipFor(run: { status: string; conclusion: string }) {
  if (run.status !== "completed") {
    return { kind: "wait", label: run.status.replace("_", " ") } as const;
  }
  if (run.conclusion === "success") return { kind: "run", label: "success" } as const;
  if (FAILED.has(run.conclusion)) {
    return { kind: "fail", label: run.conclusion.replace("_", " ") } as const;
  }
  return { kind: "idle", label: run.conclusion || "done" } as const;
}

/** GitHub Actions runs for a project: status, the failing job's log, re-run, cancel. */
export default function ActionsPanel({ project }: { project: string }) {
  const [open, setOpen] = useState<number | null>(null);
  const {
    data: runs,
    error,
    refresh,
  } = usePoll<WorkflowRun[]>(`/api/projects/${project}/runs`, 15_000);

  return (
    <>
      <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
        Workflow runs
      </div>

      {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

      <div className="flex flex-col gap-2.5">
        {runs?.map((run) => <RunRow key={run.id} run={run} onClick={() => setOpen(run.id)} />)}
        {runs?.length === 0 && (
          <div className="font-mono text-[12.5px] text-faint">no workflow runs</div>
        )}
        {!runs && !error && <div className="font-mono text-[12.5px] text-faint">…</div>}
      </div>

      {open !== null && (
        <RunSheet
          project={project}
          id={open}
          onClose={() => setOpen(null)}
          onChanged={refresh}
        />
      )}
    </>
  );
}

function RunRow({ run, onClick }: { run: WorkflowRun; onClick: () => void }) {
  const live = run.status !== "completed";
  const chip = chipFor(run);
  return (
    <div
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-[11px] border border-line bg-surface px-[15px] py-[13px] text-left transition hover:border-faint ${live ? "" : "opacity-60"}`}
    >
      <StatusDot running={live} />
      <div className="min-w-0 flex-1">
        <div className="overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap">
          {run.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2.5 font-mono text-[12px] text-faint">
          <span>{run.workflow}</span>
          <span className="min-w-0 truncate">⎇ {run.branch}</span>
          <span>{run.event}</span>
          <span className="whitespace-nowrap">{agoLabel(run.createdAt)}</span>
        </div>
      </div>
      <StatusChip kind={chip.kind} label={chip.label} />
    </div>
  );
}

function RunSheet({
  project,
  id,
  onClose,
  onChanged,
}: {
  project: string;
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<RunLog | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  // Step-by-step progress is the one live thing here. Polling does not stop once
  // the run lands: usePoll clears its data when the path or interval changes, so
  // pausing would blank the sheet the user is reading.
  const { data: detail, refresh } = usePoll<WorkflowRunDetail>(
    `/api/projects/${project}/runs/${id}`,
    10_000,
  );

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const post = (op: string, body?: unknown) =>
    api(`/api/projects/${project}/runs/${id}/${op}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });

  async function cancel() {
    const ok = await confirm({
      title: "Cancel this run?",
      body: "The workflow stops where it is.",
      action: "cancel the run",
      danger: true,
    });
    if (!ok) return;
    void act(() => post("cancel"));
  }

  const live = detail ? detail.status !== "completed" : false;
  const failed = detail ? FAILED.has(detail.conclusion) : false;

  return (
    <>
      <Sheet
        title={detail ? detail.title : `run ${id}`}
        sub={
          detail
            ? `${detail.workflow} · ⎇ ${detail.branch} · ${detail.event} · ${agoLabel(detail.createdAt)}`
            : "…"
        }
        onClose={() => !busy && onClose()}
      >
        {error && <div className="mb-2.5 font-mono text-[12px] text-wait">{error}</div>}

        <div className="mb-3 flex flex-wrap gap-2">
          {failed && (
            <button
              onClick={() =>
                act(async () =>
                  setLog(await api<RunLog>(`/api/projects/${project}/runs/${id}/log`)),
                )
              }
              disabled={busy}
              className="flex-1 rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "working…" : "◫ failed logs"}
            </button>
          )}
          {live ? (
            <button
              onClick={cancel}
              disabled={busy}
              className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
            >
              ✕ cancel
            </button>
          ) : (
            <>
              <button
                onClick={() => act(() => post("rerun"))}
                disabled={busy}
                className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
              >
                ⟲ re-run all
              </button>
              {failed && (
                <button
                  onClick={() => act(() => post("rerun", { failed: true }))}
                  disabled={busy}
                  className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
                >
                  ⟲ failed only
                </button>
              )}
            </>
          )}
          {detail && (
            <a
              href={detail.url}
              target="_blank"
              rel="noreferrer"
              className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
            >
              ↗
            </a>
          )}
        </div>

        <div className="max-h-[46vh] overflow-auto">
          {detail?.jobs.map((job) => {
            const chip = chipFor(job);
            return (
              <div key={job.name} className="mb-3">
                <div className="flex items-center gap-2 font-mono text-[12.5px]">
                  <span className="min-w-0 truncate">{job.name}</span>
                  <span className="ml-auto flex-none">
                    <StatusChip kind={chip.kind} label={chip.label} />
                  </span>
                </div>
                {job.steps.map((step) => (
                  <div
                    key={step.name}
                    className="flex gap-2 pl-2.5 font-mono text-[11px] text-faint"
                  >
                    <span className="w-3 flex-none">
                      {step.conclusion === "success"
                        ? "✓"
                        : FAILED.has(step.conclusion)
                          ? "✕"
                          : "·"}
                    </span>
                    <span className="min-w-0 truncate">{step.name}</span>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </Sheet>
      {log && (
        <CodeOverlay
          title={`${detail?.workflow ?? "run"} — failed logs`}
          text={log.log}
          truncated={log.truncated}
          onClose={() => setLog(null)}
        />
      )}
      {confirmDialog}
    </>
  );
}
