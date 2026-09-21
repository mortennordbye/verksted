import { useReducer, useRef, useState } from "react";
import type { TreeNode } from "../../../shared/api";
import { fileIcon, folderIcon } from "../fileicons";
import { SkeletonLines } from "./Skeleton";
import Notice from "./ui/Notice";

/**
 * Which folders are open, per tree, outside React.
 *
 * The sidebar is unmounted whenever you switch to the changes tab, or search,
 * or a companion pane — and on a phone that is every time you look at anything
 * else. The expansion went with it, so coming back to the tree meant opening
 * four folders again to get to the file you had just been reading. Module
 * state because it is exactly what should outlive the component: a per-device
 * preference nobody wants written down anywhere.
 */
const openDirs = new Map<string, Set<string>>();

function Node({
  node,
  open,
  onToggle,
  onOpenFile,
}: {
  node: TreeNode;
  open: (path: string) => boolean;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  if (node.type === "dir") {
    const shown = open(node.path);
    return (
      <li>
        <button
          onClick={() => onToggle(node.path)}
          title={node.path}
          // A folder is a disclosure, and nothing said whether it was open:
          // a screen reader read the same words either way.
          aria-expanded={shown}
          className="tap flex w-full items-center gap-[7px] rounded-md px-2.5 py-1 text-left text-text hover:bg-surface-2"
        >
          <img src={folderIcon(node.name, shown)} alt="" className="h-4 w-4 flex-none" />
          {/* truncate, not nowrap: a deep path used to force the whole sidebar
              to scroll sideways on a phone. */}
          <span className="truncate">{node.name}/</span>
        </button>
        {shown && node.children && node.children.length > 0 && (
          <ul className="pl-4">
            {node.children.map((c) => (
              <Node key={c.path} node={c} open={open} onToggle={onToggle} onOpenFile={onOpenFile} />
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
  treeKey,
  title,
  nodes,
  truncated,
  onOpenFile,
  onUpload,
}: {
  /** What the remembered expansion belongs to — the repo. */
  treeKey: string;
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
  // The set is read straight out of the map on every render, so a mount after
  // the sidebar was away picks up where it left off; this only asks React to
  // draw again once it changes.
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const isOpen = (path: string) => openDirs.get(treeKey)?.has(path) === true;
  const toggle = (path: string) => {
    const dirs = openDirs.get(treeKey) ?? new Set<string>();
    if (!dirs.delete(path)) dirs.add(path);
    openDirs.set(treeKey, dirs);
    redraw();
  };
  return (
    <nav
      aria-label="file tree"
      className="min-h-0 flex-1 overflow-auto rounded-xl border border-line bg-surface px-2 py-3 font-mono text-[12.5px]"
    >
      <div className="flex items-center px-2.5 pb-2.5 caps">
        {title}
        {onUpload && (
          <>
            <button
              onClick={() => picker.current?.click()}
              disabled={busy}
              title="upload file to the repo root"
              className="tap-hit ml-auto normal-case tracking-normal text-muted hover:text-text disabled:opacity-50"
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
        <Notice kind="fail" small className="mx-2.5 mb-2">
          {uploadError}
        </Notice>
      )}
      <ul>
        {(nodes ?? []).map((n) => (
          <Node key={n.path} node={n} open={isOpen} onToggle={toggle} onOpenFile={onOpenFile} />
        ))}
        {nodes === null && (
          <li>
            <SkeletonLines count={6} className="px-2.5 py-1" />
          </li>
        )}
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
