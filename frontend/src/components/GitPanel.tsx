import { useState } from "react";
import type { GitFileStatus, GitStatus } from "../../../shared/api";
import { api } from "../api";
import { fileIcon } from "../fileicons";

const STATUS_COLOR: Record<string, string> = {
  M: "text-wait",
  R: "text-wait",
  T: "text-wait",
  U: "text-run",
  A: "text-run",
  D: "text-claude",
};

/** Row action buttons show on hover (desktop) and always on touch screens. */
const ACTIONS_CLS = "hidden items-center pointer-fine:group-hover:flex pointer-coarse:flex";

function IconButton({
  glyph,
  title,
  onClick,
  disabled,
}: {
  glyph: string;
  title: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      className="rounded px-1 text-muted hover:bg-line hover:text-text disabled:opacity-50"
    >
      {glyph}
    </button>
  );
}

function FileRow({
  file,
  onOpenDiff,
  actions,
  busy,
}: {
  file: GitFileStatus;
  onOpenDiff: (file: GitFileStatus) => void;
  actions: { glyph: string; title: string; run: () => void }[];
  busy: boolean;
}) {
  const name = file.path.split("/").at(-1)!;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
  const deleted = file.status === "D";
  return (
    <li className="group">
      {/* div, not button: the action buttons nest inside the clickable row */}
      <div
        onClick={() => onOpenDiff(file)}
        className="flex w-full cursor-pointer items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-muted hover:bg-surface-2 hover:text-text"
      >
        <img src={fileIcon(name)} alt="" className="h-4 w-4 flex-none" />
        <span className={`text-text ${deleted ? "line-through opacity-60" : ""}`}>{name}</span>
        {dir && <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>}
        <span className={`ml-auto ${ACTIONS_CLS}`}>
          {actions.map((a) => (
            <IconButton key={a.title} glyph={a.glyph} title={a.title} onClick={a.run} disabled={busy} />
          ))}
        </span>
        <span className={`pl-1.5 ${STATUS_COLOR[file.status] ?? "text-muted"}`}>{file.status}</span>
      </div>
    </li>
  );
}

export default function GitPanel({
  project,
  status,
  onOpenDiff,
  onRefresh,
}: {
  project: string;
  status: GitStatus | null;
  onOpenDiff: (file: GitFileStatus) => void;
  onRefresh: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const files = status?.files ?? [];
  const staged = files.filter((f) => f.staged);
  const unstaged = files.filter((f) => !f.staged);

  async function run(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      onRefresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const gitOp = (op: "stage" | "unstage" | "discard", paths: string[]) =>
    run(() =>
      api(`/api/projects/${project}/git/${op}`, {
        method: "POST",
        body: JSON.stringify({ paths }),
      }),
    );

  function discard(files: GitFileStatus[]) {
    const untracked = files.filter((f) => f.status === "U").length;
    const what = files.length === 1 ? files[0]!.path : `${files.length} files`;
    const warn = untracked > 0 ? " Untracked files are deleted." : "";
    if (!confirm(`Discard changes in ${what}? This cannot be undone.${warn}`)) return;
    gitOp("discard", files.map((f) => f.path));
  }

  const canCommit = !busy && message.trim() !== "" && staged.length > 0;

  const commit = () =>
    run(async () => {
      await api(`/api/projects/${project}/git/commit`, {
        method: "POST",
        body: JSON.stringify({ message: message.trim() }),
      });
      setMessage("");
    });

  function section(
    label: string,
    items: GitFileStatus[],
    headerActions: { glyph: string; title: string; run: () => void }[],
    rowActions: (f: GitFileStatus) => { glyph: string; title: string; run: () => void }[],
  ) {
    return (
      <>
        <div className="group flex items-center gap-1.5 px-2.5 pt-2.5 pb-1 text-[11px] tracking-widest text-faint uppercase">
          {label}
          <span className={ACTIONS_CLS}>
            {headerActions.map((a) => (
              <IconButton key={a.title} glyph={a.glyph} title={a.title} onClick={a.run} disabled={busy} />
            ))}
          </span>
          <span className="ml-auto rounded-full bg-surface-2 px-1.5 py-px text-[10px] normal-case tracking-normal text-muted">
            {items.length}
          </span>
        </div>
        <ul>
          {items.map((f) => (
            <FileRow key={f.path} file={f} onOpenDiff={onOpenDiff} actions={rowActions(f)} busy={busy} />
          ))}
        </ul>
      </>
    );
  }

  return (
    <nav className="max-h-[calc(100dvh-240px)] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
      <div className="flex items-center px-2.5 pb-2 text-[11px] tracking-widest text-faint uppercase">
        source control
        <span className="ml-auto normal-case tracking-normal text-muted">
          ⎇ {status?.branch ?? "…"}
        </span>
      </div>
      <div className="px-2.5">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canCommit) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={`Message (⌘⏎ to commit on "${status?.branch ?? "…"}")`}
          rows={2}
          className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] outline-none placeholder:text-faint focus:border-accent"
        />
        <button
          onClick={commit}
          disabled={!canCommit}
          className="mt-1 w-full rounded-[7px] bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-[#16130a] hover:brightness-110 disabled:opacity-50"
        >
          {busy ? "working…" : "✓ Commit"}
        </button>
        {error && <div className="mt-1 text-[11px] text-wait">{error}</div>}
      </div>
      {status && files.length === 0 && (
        <div className="px-2.5 pt-2 text-faint">working tree clean</div>
      )}
      {staged.length > 0 &&
        section(
          "staged changes",
          staged,
          [{ glyph: "−", title: "unstage all", run: () => gitOp("unstage", staged.map((f) => f.path)) }],
          (f) => [{ glyph: "−", title: "unstage", run: () => gitOp("unstage", [f.path]) }],
        )}
      {unstaged.length > 0 &&
        section(
          "changes",
          unstaged,
          [
            { glyph: "⟲", title: "discard all changes", run: () => discard(unstaged) },
            { glyph: "+", title: "stage all", run: () => gitOp("stage", unstaged.map((f) => f.path)) },
          ],
          (f) => [
            { glyph: "⟲", title: "discard changes", run: () => discard([f]) },
            { glyph: "+", title: "stage", run: () => gitOp("stage", [f.path]) },
          ],
        )}
    </nav>
  );
}
