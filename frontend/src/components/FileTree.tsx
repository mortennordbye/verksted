import { useReducer, useRef, useState, type KeyboardEvent } from "react";
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

/** A node as the tree draws it: where it sits, and who it hangs off. */
interface Row {
  node: TreeNode;
  level: number;
  parent: string | null;
}

/** The rows a person can see right now, top to bottom: what the arrows walk. */
function visible(nodes: TreeNode[], open: (path: string) => boolean): Row[] {
  const out: Row[] = [];
  const walk = (list: TreeNode[], level: number, parent: string | null) => {
    for (const node of list) {
      out.push({ node, level, parent });
      if (node.type === "dir" && open(node.path) && node.children) {
        walk(node.children, level + 1, node.path);
      }
    }
  };
  walk(nodes, 1, null);
  return out;
}

function Node({
  node,
  level,
  open,
  current,
  onToggle,
  onOpenFile,
  onFocusRow,
  register,
}: {
  node: TreeNode;
  level: number;
  open: (path: string) => boolean;
  /** The one row Tab lands on. */
  current: string | null;
  onToggle: (path: string) => void;
  onOpenFile: (path: string) => void;
  onFocusRow: (path: string) => void;
  register: (path: string, el: HTMLLIElement | null) => void;
}) {
  const dir = node.type === "dir";
  const shown = dir && open(node.path);
  return (
    // A treeitem is the focusable thing itself, so the row is not a button
    // inside it: the keys are the tree's (see onKeyDown below), and a click
    // is taken here only when it landed on this row rather than a child's.
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events
    <li
      ref={(el) => register(node.path, el)}
      role="treeitem"
      aria-level={level}
      aria-expanded={dir ? shown : undefined}
      aria-label={node.name}
      aria-selected={node.path === current}
      tabIndex={node.path === current ? 0 : -1}
      title={node.path}
      onFocus={(e) => e.target === e.currentTarget && onFocusRow(node.path)}
      onClick={(e) => {
        if ((e.target as Element).closest('[role="treeitem"]') !== e.currentTarget) return;
        if (dir) onToggle(node.path);
        else onOpenFile(node.path);
      }}
      className="rounded-md outline-offset-[-2px]"
    >
      <div
        className={`tap flex w-full cursor-pointer items-center gap-[7px] rounded-md px-2.5 py-1 hover:bg-surface-2 ${
          dir ? "text-text" : "text-muted hover:text-text"
        }`}
      >
        <img
          src={dir ? folderIcon(node.name, shown) : fileIcon(node.name)}
          alt=""
          className="h-4 w-4 flex-none"
        />
        {/* truncate, not nowrap: a deep path used to force the whole sidebar
            to scroll sideways on a phone. */}
        <span className="truncate">{dir ? `${node.name}/` : node.name}</span>
        {!dir && node.modified && (
          <span className="ml-auto flex-none text-[10px] text-wait">M</span>
        )}
      </div>
      {shown && node.children && node.children.length > 0 && (
        <ul role="group" className="pl-4">
          {node.children.map((c) => (
            <Node
              key={c.path}
              node={c}
              level={level + 1}
              open={open}
              current={current}
              onToggle={onToggle}
              onOpenFile={onOpenFile}
              onFocusRow={onFocusRow}
              register={register}
            />
          ))}
        </ul>
      )}
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

  /**
   * The tree as a keyboard walks it (F-38).
   *
   * Every file and folder was its own button, so reaching the fortieth file
   * was forty presses of Tab, and nothing said a folder had rows inside it.
   * As an ARIA tree it is one tab stop: the arrows move between the rows you
   * can see, right opens a folder or steps into it, left closes it or climbs
   * to its parent, Home and End go to the ends, Enter opens, and typing a
   * letter jumps to the next row that starts with it.
   */
  const rows = visible(nodes ?? [], isOpen);
  const [focused, setFocused] = useState<string | null>(null);
  const current = rows.some((r) => r.node.path === focused)
    ? focused
    : (rows[0]?.node.path ?? null);
  const els = useRef(new Map<string, HTMLLIElement>());
  const register = (path: string, el: HTMLLIElement | null) => {
    if (el) els.current.set(path, el);
    else els.current.delete(path);
  };
  const moveTo = (path: string | null | undefined) => {
    if (!path) return;
    setFocused(path);
    els.current.get(path)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const at = rows.findIndex((r) => r.node.path === current);
    const row = rows[at];
    if (!row) return;
    const dir = row.node.type === "dir";
    const openNow = dir && isOpen(row.node.path);
    let handled = true;
    switch (e.key) {
      case "ArrowDown":
        moveTo(rows[at + 1]?.node.path);
        break;
      case "ArrowUp":
        moveTo(rows[at - 1]?.node.path);
        break;
      case "Home":
        moveTo(rows[0]?.node.path);
        break;
      case "End":
        moveTo(rows.at(-1)?.node.path);
        break;
      case "ArrowRight":
        if (dir && !openNow) toggle(row.node.path);
        else if (openNow) moveTo(row.node.children?.[0]?.path);
        break;
      case "ArrowLeft":
        if (openNow) toggle(row.node.path);
        else moveTo(row.parent);
        break;
      case "Enter":
      case " ":
        if (dir) toggle(row.node.path);
        else onOpenFile(row.node.path);
        break;
      default:
        if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          const key = e.key.toLowerCase();
          const after = [...rows.slice(at + 1), ...rows.slice(0, at + 1)];
          moveTo(after.find((r) => r.node.name.toLowerCase().startsWith(key))?.node.path);
        } else handled = false;
    }
    if (handled) e.preventDefault();
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
      {nodes === null && <SkeletonLines count={6} className="px-2.5 py-1" />}
      {nodes?.length === 0 && <div className="px-2.5 text-faint">empty repo</div>}
      {nodes && nodes.length > 0 && (
        <ul role="tree" aria-label={title} onKeyDown={onKeyDown}>
          {nodes.map((n) => (
            <Node
              key={n.path}
              node={n}
              level={1}
              open={isOpen}
              current={current}
              onToggle={toggle}
              onOpenFile={onOpenFile}
              onFocusRow={setFocused}
              register={register}
            />
          ))}
        </ul>
      )}
      {truncated && (
        // Otherwise a missing file reads as "not there" rather than "the
        // tree stopped early".
        <div className="px-2.5 pt-2 text-[11px] text-wait">
          too many files — this tree is incomplete
        </div>
      )}
    </nav>
  );
}
