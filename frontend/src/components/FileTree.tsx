import { useRef, useState } from "react";
import type { TreeNode } from "../../../shared/api";
import { fileIcon, folderIcon } from "../fileicons";

function Node({
  node,
  onOpenFile,
}: {
  node: TreeNode;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (node.type === "dir") {
    return (
      <li>
        <button
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-text hover:bg-surface-2"
        >
          <img src={folderIcon(node.name, open)} alt="" className="h-4 w-4 flex-none" />
          {node.name}/
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
        className="flex w-full items-center gap-[7px] whitespace-nowrap rounded-md px-2.5 py-1 text-left text-muted hover:bg-surface-2 hover:text-text"
      >
        <img src={fileIcon(node.name)} alt="" className="h-4 w-4 flex-none" />
        {node.name}
        {node.modified && <span className="ml-auto text-[10px] text-wait">M</span>}
      </button>
    </li>
  );
}

export default function FileTree({
  title,
  nodes,
  onOpenFile,
  onUpload,
}: {
  title: string;
  nodes: TreeNode[] | null;
  onOpenFile: (path: string) => void;
  onUpload?: (file: File) => Promise<void>;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  return (
    <nav className="max-h-[calc(100dvh-240px)] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
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
                try {
                  await onUpload(f);
                } finally {
                  setBusy(false);
                }
              }}
            />
          </>
        )}
      </div>
      <ul>
        {(nodes ?? []).map((n) => (
          <Node key={n.path} node={n} onOpenFile={onOpenFile} />
        ))}
        {nodes?.length === 0 && <li className="px-2.5 text-faint">empty repo</li>}
      </ul>
    </nav>
  );
}
