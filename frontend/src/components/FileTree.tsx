import { useState } from "react";
import type { TreeNode } from "../../../shared/api";

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
          <span className="w-2.5 flex-none text-[10px] text-faint">{open ? "▾" : "▸"}</span>
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
        <span className="w-2.5 flex-none" />
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
}: {
  title: string;
  nodes: TreeNode[] | null;
  onOpenFile: (path: string) => void;
}) {
  return (
    <nav className="max-h-[68vh] overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]">
      <div className="px-2.5 pb-2.5 text-[11px] tracking-widest text-faint uppercase">{title}</div>
      <ul>
        {(nodes ?? []).map((n) => (
          <Node key={n.path} node={n} onOpenFile={onOpenFile} />
        ))}
        {nodes?.length === 0 && <li className="px-2.5 text-faint">empty repo</li>}
      </ul>
    </nav>
  );
}
