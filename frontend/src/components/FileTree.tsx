import { useRef, useState } from "react";
import type { TreeNode } from "../../../shared/api";
import { fileIcon, folderIcon } from "../fileicons";

function Node({ node, onOpenFile }: { node: TreeNode; onOpenFile: (path: string) => void }) {
  const [open, setOpen] = useState(false);
  if (node.type === "dir") {
    return (
      <li>
        <button
          onClick={() => setOpen(!open)}
          title={node.path}
          className="tap flex w-full items-center gap-[7px] rounded-md px-2.5 py-1 text-left text-text hover:bg-surface-2"
        >
          <img src={folderIcon(node.name, open)} alt="" className="h-4 w-4 flex-none" />
          {/* truncate, not nowrap: a deep path used to force the whole sidebar
              to scroll sideways on a phone. */}
          <span className="truncate">{node.name}/</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul className="pl-4">
            {node.children.map((c) => (
              <Node key={c.path} node={c} onOpenFile={onOpenFile} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  return (
    <li>
      <button
        onClick={() => onOpenFile(node.path)}
        title={node.path}
        className="tap flex w-full items-center gap-[7px] rounded-md px-2.5 py-1 text-left text-muted hover:bg-surface-2 hover:text-text"
      >
        <img src={fileIcon(node.name)} alt="" className="h-4 w-4 flex-none" />
        <span className="truncate">{node.name}</span>
        {node.modified && <span className="ml-auto flex-none text-[10px] text-wait">M</span>}
      </button>
    </li>
  );
}

export default function FileTree({
  title,
  nodes,
  truncated,
  onOpenFile,
  onUpload,
}: {
  title: string;
  nodes: TreeNode[] | null;
  /** The walk hit its entry budget, so files are missing from this tree. */
  truncated?: boolean;
  onOpenFile: (path: string) => void;
  onUpload?: (file: File) => Promise<void>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  return (
    <nav
      aria-label="file tree"
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]"
    >
      <div className="flex items-center px-2.5 pb-2.5 text-[11px] tracking-widest text-faint uppercase">
        {title}
        {onUpload && (
          <>
            <button
              onClick={() => picker.current?.click()}
              disabled={busy}
              title="upload file to the repo root"
              className="ml-auto normal-case tracking-normal text-muted hover:text-text disabled:opacity-50"
            >
              {busy ? "…" : "⤒ upload"}
            </button>
            <input
              ref={picker}
              type="file"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (!f) return;
                setBusy(true);
                setUploadError(null);
                try {
                  await onUpload(f);
                } catch (err) {
                  setUploadError((err as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </>
        )}
      </div>
      {uploadError && (
        <div className="mb-2 px-2.5 text-[11px] break-words text-fail">{uploadError}</div>
      )}
      <ul>
        {(nodes ?? []).map((n) => (
          <Node key={n.path} node={n} onOpenFile={onOpenFile} />
        ))}
        {nodes?.length === 0 && <li className="px-2.5 text-faint">empty repo</li>}
        {truncated && (
          // Otherwise a missing file reads as "not there" rather than "the
          // tree stopped early".
          <li className="px-2.5 pt-2 text-[11px] text-wait">
            too many files — this tree is incomplete
          </li>
        )}
      </ul>
    </nav>
  );
}
