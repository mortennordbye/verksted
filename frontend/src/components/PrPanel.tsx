import { useState } from "react";
import type { PrDiff, PullRequest, PullRequestDetail, MergeResult } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import { StatusChip } from "./StatusChip";
import Sheet, { focusIfPointerFine } from "./Sheet";
import CodeOverlay from "./CodeOverlay";

const CHECK_CHIP = {
  passing: { kind: "run", label: "checks ok" },
  failing: { kind: "fail", label: "checks failed" },
  pending: { kind: "wait", label: "checks running" },
  none: { kind: "idle", label: "open" },
} as const;

/** The one chip a PR row shows: its state, else its draft flag, else its checks. */
function chipFor(pr: PullRequest) {
  if (pr.state !== "OPEN") return { kind: "idle", label: pr.state.toLowerCase() } as const;
  if (pr.isDraft) return { kind: "idle", label: "draft" } as const;
  return CHECK_CHIP[pr.checks];
}

/**
 * Pull requests for a project: list them, read the conversation and the diff,
 * check one out to work on, squash-merge it. gh resolves the repository from the
 * checkout's remote, so nothing here names a GitHub repo.
 */
export default function PrPanel({
  project,
  onChanged,
}: {
  project: string;
  onChanged: () => void;
}) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const {
    data: prs,
    error,
    refresh,
  } = usePoll<PullRequest[]>(
    `/api/projects/${project}/prs?state=${all ? "all" : "open"}`,
    20_000,
  );

  return (
    <>
      <div className="mb-2.5 flex items-center gap-2">
        <div className="font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Pull requests
        </div>
        <button
          onClick={() => setAll(!all)}
          className="ml-auto rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
        >
          {all ? "open only" : "show closed"}
        </button>
        <button
          onClick={() => setCreating(true)}
          className="rounded-md border border-line px-2 py-0.5 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
        >
          ＋ new pr
        </button>
      </div>

      {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

      <div className="flex flex-col gap-2.5">
        {prs?.map((pr) => <PrRow key={pr.number} pr={pr} onClick={() => setOpen(pr.number)} />)}
        {prs?.length === 0 && (
          <div className="font-mono text-[12.5px] text-faint">
            {all ? "no pull requests" : "no open pull requests"}
          </div>
        )}
        {!prs && !error && <div className="font-mono text-[12.5px] text-faint">…</div>}
      </div>

      {open !== null && (
        <PrSheet
          project={project}
          number={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            refresh();
            onChanged();
          }}
        />
      )}
      {creating && (
        <CreatePrSheet
          project={project}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
            onChanged();
          }}
        />
      )}
    </>
  );
}

function PrRow({ pr, onClick }: { pr: PullRequest; onClick: () => void }) {
  const chip = chipFor(pr);
  return (
    <div
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-[11px] border border-line bg-surface px-[15px] py-[13px] text-left transition hover:border-faint ${pr.state === "OPEN" ? "" : "opacity-60"}`}
    >
      <span className="w-9 flex-none font-mono text-[12px] text-faint">#{pr.number}</span>
      <div className="min-w-0 flex-1">
        <div className="overflow-hidden text-[13.5px] text-ellipsis whitespace-nowrap">
          {pr.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2.5 font-mono text-[12px] text-faint">
          <span className="min-w-0 truncate">⎇ {pr.headRefName}</span>
          <span className="text-run">+{pr.additions}</span>
          <span className="text-claude">−{pr.deletions}</span>
          <span className="whitespace-nowrap">{agoLabel(pr.updatedAt)}</span>
          {pr.reviewDecision === "APPROVED" && <span className="text-run">approved</span>}
          {pr.reviewDecision === "CHANGES_REQUESTED" && (
            <span className="text-wait">changes requested</span>
          )}
        </div>
      </div>
      <StatusChip kind={chip.kind} label={chip.label} />
    </div>
  );
}

function PrSheet({
  project,
  number,
  onClose,
  onChanged,
}: {
  project: string;
  number: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [diff, setDiff] = useState<PrDiff | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const { data: pr, refresh } = usePoll<PullRequestDetail>(
    `/api/projects/${project}/prs/${number}`,
    30_000,
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

  const post = <T,>(op: string) =>
    api<T>(`/api/projects/${project}/prs/${number}/${op}`, { method: "POST" });

  async function merge() {
    const ok = await confirm({
      title: `Squash-merge PR #${number}?`,
      body: `It merges into ${pr?.baseRefName} and the head branch is deleted.`,
      action: "squash and merge",
    });
    if (!ok) return;
    run(async () => {
      const res = await post<MergeResult>("merge");
      // Merged, but something local did not go to plan — say so rather than
      // leaving a stale branch to be discovered later.
      setNote(res.detail ?? null);
    });
  }

  const open = pr?.state === "OPEN";
  return (
    <>
      <Sheet
        title={pr ? `#${pr.number} ${pr.title}` : `#${number}`}
        sub={
          pr
            ? `${pr.author} · ⎇ ${pr.headRefName} → ${pr.baseRefName} · ${pr.changedFiles} file${pr.changedFiles === 1 ? "" : "s"} · ${agoLabel(pr.updatedAt)}`
            : "…"
        }
        onClose={() => !busy && onClose()}
      >
        {error && <div className="mb-2.5 font-mono text-[12px] text-wait">{error}</div>}
        {note && <div className="mb-2.5 font-mono text-[12px] text-wait">{note}</div>}

        <div className="mb-3 flex flex-wrap gap-2">
          <button
            onClick={merge}
            disabled={busy || !open}
            title={open ? "squash and delete the branch" : `already ${pr?.state.toLowerCase()}`}
            className="flex-1 rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "working…" : open ? "⑃ squash merge" : (pr?.state.toLowerCase() ?? "…")}
          </button>
          <button
            onClick={() => run(() => post<{ branch: string }>("checkout"))}
            disabled={busy}
            title="check this branch out in the project"
            className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
          >
            ⇄ checkout
          </button>
          <button
            onClick={() =>
              run(async () =>
                setDiff(await api<PrDiff>(`/api/projects/${project}/prs/${number}/diff`)),
              )
            }
            disabled={busy}
            className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
          >
            ◫ diff
          </button>
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="flex-none rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
            >
              ↗
            </a>
          )}
        </div>

        <div className="max-h-[46vh] overflow-auto">
          {pr?.body && (
            <div className="mb-3 rounded-[11px] border border-line bg-surface-2 px-3 py-2.5 font-mono text-[12.5px] whitespace-pre-wrap text-muted">
              {pr.body}
            </div>
          )}
          {pr?.comments.map((c, i) => (
            <div key={i} className="mb-2 border-l-2 border-line pl-2.5">
              <div className="font-mono text-[11px] text-faint">
                {c.author}
                {c.state && c.state !== "COMMENTED" && (
                  <span className={c.state === "APPROVED" ? " text-run" : " text-wait"}>
                    {" "}
                    {c.state.toLowerCase().replace("_", " ")}
                  </span>
                )}{" "}
                · {agoLabel(c.createdAt)}
              </div>
              {c.body && (
                <div className="font-mono text-[12.5px] whitespace-pre-wrap text-muted">
                  {c.body}
                </div>
              )}
            </div>
          ))}
          {pr && pr.files.length > 0 && (
            <div className="mt-3 font-mono text-[11px] text-faint">
              {pr.files.map((f) => (
                <div key={f.path} className="flex gap-2">
                  <span className="min-w-0 flex-1 truncate">{f.path}</span>
                  <span className="flex-none text-run">+{f.additions}</span>
                  <span className="flex-none text-claude">−{f.deletions}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Sheet>
      {diff && (
        <CodeOverlay
          title={`#${number} diff`}
          text={diff.diff}
          diff
          truncated={diff.truncated}
          onClose={() => setDiff(null)}
        />
      )}
      {confirmDialog}
    </>
  );
}

function CreatePrSheet({
  project,
  onClose,
  onCreated,
}: {
  project: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${project}/prs`, {
        method: "POST",
        body: JSON.stringify({ title: title.trim(), body, draft }),
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      title={`New pull request in ~/${project}`}
      sub="Pushes the current branch to origin and opens a PR against the default branch. The tree has to be clean — commit first."
      onClose={() => !busy && onClose()}
    >
      {error && <div className="mb-2.5 font-mono text-[12px] text-wait">{error}</div>}
      <input
        ref={focusIfPointerFine}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="title"
        className="w-full rounded-[11px] border border-line bg-surface-2 px-3.5 py-3 font-mono text-[14px] outline-none placeholder:text-faint focus:border-accent"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="description (optional)"
        rows={5}
        className="mt-2 w-full resize-y rounded-[11px] border border-line bg-surface-2 px-3.5 py-3 font-mono text-[13px] outline-none placeholder:text-faint focus:border-accent"
      />
      <label className="mt-3 flex items-center gap-2.5 font-mono text-[12px] text-muted">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          className="accent-accent"
        />
        open as a draft
      </label>
      <button
        onClick={create}
        disabled={busy || !title.trim()}
        className="mt-3 w-full rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
      >
        {busy ? "pushing…" : "push and open pr"}
      </button>
    </Sheet>
  );
}
