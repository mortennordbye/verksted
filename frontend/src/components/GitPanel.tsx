import type { GitStatus } from "../../../shared/api";
import { fileIcon } from "../fileicons";

const STATUS_COLOR: Record<string, string> = {
  M: "text-wait",
  R: "text-wait",
  T: "text-wait",
  U: "text-run",
  A: "text-run",
  D: "text-claude",
};

export default function GitPanel({
  status,
  onOpenFile,
}: {
  status: GitStatus | null;
  onOpenFile: (path: string) => void;
}) {
  const files = status?.files ?? [];
  return (
    <nav className="max-h-[calc(100dvh-240px)] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
      <div className="flex items-center px-2.5 pb-2.5 text-[11px] tracking-widest text-faint uppercase">
        changes
        {files.length > 0 && <span className="ml-1.5 text-muted">{files.length}</span>}
        <span className="ml-auto normal-case tracking-normal text-muted">
          ⎇ {status?.branch ?? "…"}
        </span>
      </div>
      {status && files.length === 0 && (
        <div className="px-2.5 text-faint">working tree clean</div>
      )}
      <ul>
        {files.map((f) => {
          const name = f.path.split("/").at(-1)!;
          const dir = f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "";
          const deleted = f.status === "D";
          return (
            <li key={f.path}>
              <button
                onClick={() => onOpenFile(f.path)}
                disabled={deleted}
                className="flex w-full items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-muted hover:bg-surface-2 hover:text-text disabled:opacity-50"
              >
                <img src={fileIcon(name)} alt="" className="h-4 w-4 flex-none" />
                <span className={`text-text ${deleted ? "line-through" : ""}`}>{name}</span>
                {dir && <span className="min-w-0 truncate text-[11px] text-faint">{dir}</span>}
                <span className={`ml-auto pl-2 ${STATUS_COLOR[f.status] ?? "text-muted"}`}>
                  {f.status}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
