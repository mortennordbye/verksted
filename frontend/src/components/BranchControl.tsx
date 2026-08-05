import { useState } from "react";
import type { GitBranches } from "../../../shared/api";
import { api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import Sheet from "./Sheet";

/**
 * The "⎇ branch" label, clickable: switch branch, pull, or reset the branch to
 * its upstream. Pull is always fast-forward — reset is the only destructive way
 * out of a diverged branch, and it asks first.
 */
export default function BranchControl({
  project,
  branch,
  className,
  onChanged,
}: {
  project: string;
  branch: string;
  className: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { data, refresh } = usePoll<GitBranches>(
    open ? `/api/projects/${project}/git/branches` : null,
    15_000,
  );

  async function run(fn: () => Promise<unknown>) {
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
    api(`/api/projects/${project}/git/${op}`, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });

  const switchTo = (to: string) =>
    run(async () => {
      await post("checkout", { branch: to });
      setOpen(false);
    });

  async function reset() {
    if (
      !(await confirm({
        title: `Reset ${data?.current} to ${data?.upstream}?`,
        body: "Commits and changes to tracked files that are not on the remote are lost. Untracked files are left alone.",
        action: "reset the branch",
        danger: true,
      }))
    ) {
      return;
    }
    void run(() => post("reset"));
  }

  const local = data?.local ?? [];
  // Remote-only branches switch by their short name: git makes the local
  // tracking branch on the way.
  const remoteOnly = (data?.remote ?? [])
    .map((r) => r.slice(r.indexOf("/") + 1))
    .filter((short) => !local.includes(short));
  const matches = (b: string) => b.toLowerCase().includes(filter.trim().toLowerCase());

  return (
    <>
      <button onClick={() => setOpen(true)} title="switch branch, pull" className={className}>
        ⎇ {branch}
      </button>
      {open && (
        <Sheet
          title={`Branch in ~/${project}`}
          sub={
            data
              ? `on ${data.current}${data.upstream ? ` · tracking ${data.upstream}` : " · no upstream"}`
              : "…"
          }
          onClose={() => !busy && setOpen(false)}
        >
          {error && <div className="mb-2.5 font-mono text-[12px] text-wait">{error}</div>}
          <div className="mb-3 flex gap-2">
            <button
              onClick={() => run(() => post("pull"))}
              disabled={busy || !data?.upstream}
              className="flex-1 rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
            >
              {busy ? "working…" : "↓ pull"}
            </button>
            <button
              onClick={reset}
              disabled={busy || !data?.upstream}
              title="discard local commits and changes on this branch"
              aria-label="discard local commits and changes on this branch"
              className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait disabled:opacity-50"
            >
              reset to {data?.upstream ?? "upstream"}
            </button>
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter branches"
            className="w-full rounded-[11px] border border-line bg-surface-2 px-3.5 py-2.5 font-mono text-[13px] outline-none placeholder:text-faint focus:border-accent"
          />
          <div className="mt-2 max-h-[38vh] overflow-auto">
            {local.filter(matches).map((b) => (
              <BranchRow
                key={b}
                name={b}
                current={b === data?.current}
                busy={busy}
                onClick={() => switchTo(b)}
              />
            ))}
            {remoteOnly.filter(matches).map((b) => (
              <BranchRow
                key={`remote/${b}`}
                name={b}
                remote
                busy={busy}
                onClick={() => switchTo(b)}
              />
            ))}
            {data && local.length + remoteOnly.length === 0 && (
              <div className="px-1 py-2 font-mono text-[12.5px] text-faint">no branches yet</div>
            )}
          </div>
        </Sheet>
      )}
      {confirmDialog}
    </>
  );
}

function BranchRow({
  name,
  current,
  remote,
  busy,
  onClick,
}: {
  name: string;
  current?: boolean;
  remote?: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy || current}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left font-mono text-[12.5px] disabled:opacity-100 ${
        current ? "text-text" : "text-muted hover:bg-surface-2 hover:text-text"
      }`}
    >
      <span className="w-3 flex-none text-accent">{current ? "●" : ""}</span>
      <span className="min-w-0 truncate">{name}</span>
      {remote && <span className="ml-auto flex-none text-[11px] text-faint">remote</span>}
    </button>
  );
}
