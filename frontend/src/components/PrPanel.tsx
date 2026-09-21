import { useState } from "react";
import type { PrDiff, PullRequest, PullRequestDetail, MergeResult } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { useConfirm } from "../useConfirm";
import { StatusChip } from "./StatusChip";
import Sheet, { focusIfPointerFine } from "./Sheet";
import CodeOverlay from "./CodeOverlay";
import { SkeletonList } from "./Skeleton";
import Button, { buttonClass } from "./ui/Button";
import { Input, Textarea } from "./ui/Field";
import Notice from "./ui/Notice";

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
    `/api/projects/${encodeURIComponent(project)}/prs?state=${all ? "all" : "open"}`,
    20_000,
  );

  return (
    <>
      <div className="mb-2.5 flex items-center gap-2">
        <div className="caps">Pull requests</div>
        <Button onClick={() => setAll(!all)} size="xs" className="ml-auto">
          {all ? "open only" : "show closed"}
        </Button>
        <Button onClick={() => setCreating(true)} size="xs">
          ＋ new pr
        </Button>
      </div>

      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}

      <div className="flex flex-col gap-2.5">
        {prs?.map((pr) => (
          <PrRow key={pr.number} pr={pr} onClick={() => setOpen(pr.number)} />
        ))}
        {prs?.length === 0 && (
          <div className="text-[13px] text-faint">
            {all ? "no pull requests" : "no open pull requests"}
          </div>
        )}
        {!prs && !error && (
          <SkeletonList
            count={3}
            gap="gap-2.5"
            className="h-[66px] rounded-[11px] border border-line bg-surface"
          />
        )}
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
    // A button, not a div with an onClick: the row opens the PR's sheet, and
    // as a div there was no way to reach it without a pointer.
    <button
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-3 rounded-[11px] border px-[15px] py-[13px] text-left transition hover:border-faint ${pr.state === "OPEN" ? "border-line bg-surface" : "border-line/60 bg-transparent"}`}
    >
      <span className="w-9 flex-none font-mono text-[12px] text-faint">#{pr.number}</span>
      <div className="min-w-0 flex-1">
        {/* Two lines rather than an ellipsis: this panel is now also rendered in
            the session's side column, where a single clipped line of a
            conventional-commit title is all prefix and no subject. */}
        <div className="line-clamp-2 text-[13.5px]">{pr.title}</div>
        {/* Wraps: the counts and the timestamp do not shrink, so in a narrow
            column they used to spill out of this row and under the chip. */}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[12px] text-faint">
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
      <span className="flex-none">
        <StatusChip kind={chip.kind} label={chip.label} />
      </span>
    </button>
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
    `/api/projects/${encodeURIComponent(project)}/prs/${number}`,
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
    api<T>(`/api/projects/${encodeURIComponent(project)}/prs/${number}/${op}`, { method: "POST" });

  async function merge() {
    const ok = await confirm({
      title: `Squash-merge PR #${number}?`,
      body: `It merges into ${pr?.baseRefName} and the head branch is deleted.`,
      action: "squash and merge",
    });
    if (!ok) return;
    void run(async () => {
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
        {error && (
          <Notice kind="fail" className="mb-2.5">
            {error}
          </Notice>
        )}
        {note && (
          <Notice kind="note" className="mb-2.5">
            {note}
          </Notice>
        )}

        <div className="mb-3 flex flex-wrap gap-2">
          <Button
            onClick={merge}
            disabled={busy || !open}
            title={open ? "squash and delete the branch" : `already ${pr?.state.toLowerCase()}`}
            variant="primary"
            size="lg"
            className="flex-1"
          >
            {busy ? "working…" : open ? "⑃ squash merge" : (pr?.state.toLowerCase() ?? "…")}
          </Button>
          <Button
            onClick={() => run(() => post<{ branch: string }>("checkout"))}
            disabled={busy}
            title="check this branch out in the project"
            size="lg"
            className="flex-none"
          >
            ⇄ checkout
          </Button>
          <Button
            onClick={() =>
              run(async () =>
                setDiff(
                  await api<PrDiff>(
                    `/api/projects/${encodeURIComponent(project)}/prs/${number}/diff`,
                  ),
                ),
              )
            }
            disabled={busy}
            size="lg"
            className="flex-none"
          >
            ◫ diff
          </Button>
          {pr && (
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              aria-label="open the pull request on GitHub"
              className={buttonClass("ghost", "lg", "flex-none")}
            >
              ↗
            </a>
          )}
        </div>

        <div className="max-h-[46vh] overflow-auto">
          {pr?.body && (
            <div className="mb-3 rounded-[11px] border border-line bg-surface-2 px-3 py-2.5 text-[13px] whitespace-pre-wrap text-muted">
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
              {c.body && <div className="text-[13px] whitespace-pre-wrap text-muted">{c.body}</div>}
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
      await api(`/api/projects/${encodeURIComponent(project)}/prs`, {
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
      {error && (
        <Notice kind="fail" className="mb-2.5">
          {error}
        </Notice>
      )}
      <Input
        ref={focusIfPointerFine}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="title"

        label="pull request title"
        size="lg"
        className="w-full"
      />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="description (optional)"

        rows={5}
        label="pull request description"
        size="lg"
        className="mt-2 w-full"
      />
      <label className="mt-3 flex items-center gap-2.5 text-[12.5px] text-muted">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => setDraft(e.target.checked)}
          className="accent-accent"
        />
        open as a draft
      </label>
      <Button
        onClick={create}
        disabled={busy || !title.trim()}
        variant="primary"
        size="lg"
        className="mt-3 w-full"
      >
        {busy ? "pushing…" : "push and open pr"}
      </Button>
    </Sheet>
  );
}
