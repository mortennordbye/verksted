import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.css";
import type {
  BranchSync,
  FileDiff,
  FileContent,
  GitFileStatus,
  GitStatus,
  Session as SessionInfo,
  TreeNode,
} from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import { diffLineClass } from "../diff";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
import BrowserPane from "../components/BrowserPane";
import FileTree from "../components/FileTree";
import GitPanel from "../components/GitPanel";
import SearchPanel from "../components/SearchPanel";
import Sheet from "../components/Sheet";
import { fileIcon } from "../fileicons";

/** hljs language for a path, via its extension (aliases resolve: ts, py, yml…). */
function langFor(path: string): string | null {
  const name = path.split("/").at(-1)!.toLowerCase();
  const ext = name.split(".").at(-1)!;
  return hljs.getLanguage(ext) ? ext : null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

interface Viewed {
  path: string;
  content: string;
  kind: "text" | "diff" | "image";
}

/** Phone pane tab: one strip picks files / agent / shell / browser. */
function Tab({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={on}
      onClick={onClick}
      className={`flex-none rounded-lg border px-3 py-1.5 font-mono text-[12.5px] ${
        on ? "border-accent bg-surface-2 text-text" : "border-line bg-surface text-muted"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * Publishes the visual viewport as `--vvh` (height) and `--vvt` (offset from the
 * layout viewport top). iOS Safari keeps `100dvh` — and the layout viewport —
 * at full height when the on-screen keyboard opens, so a terminal sized in dvh
 * puts the agent prompt underneath the keys. The visual viewport is the only
 * height that reflects the keyboard; sizing the screen to it (and never letting
 * the document scroll) keeps the prompt above the keyboard, and shrinking the
 * terminal box refits xterm, which resizes tmux to match.
 */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, []);
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useVisualViewport();
  // Set when this screen was reached by creating the session: says whether the
  // repo was actually moved to an up-to-date main.
  const { sync } = (useLocation().state ?? {}) as { sync?: BranchSync };
  const [syncNote, setSyncNote] = useState(sync?.status === "synced" ? null : (sync ?? null));
  const { data: session } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const { data: tree, refresh: refreshTree } = usePoll<TreeNode[]>(
    session ? `/api/projects/${session.project}/tree` : null,
    8_000,
  );
  const { data: git, refresh: refreshGit } = usePoll<GitStatus>(
    session ? `/api/projects/${session.project}/git` : null,
    8_000,
  );
  const [pane, setPane] = useState<"tree" | "term">("term");
  const [side, setSide] = useState<"files" | "git" | "search">("files");
  // Companion panes next to the agent terminal; on desktop all three can
  // share the screen, on mobile exactly one is visible at a time.
  const [shell, setShell] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [active, setActive] = useState<"agent" | "shell" | "browser">("agent");

  /** Mobile pane picker: mounts the picked pane, unmounts the other companion
      (a hidden browser would keep streaming frames to a pocketed phone). */
  function pick(p: "agent" | "shell" | "browser") {
    setActive(p);
    setShell(p === "shell");
    setBrowser(p === "browser");
  }
  const [full, setFull] = useState(false);
  const [menu, setMenu] = useState(false);
  // Agent-pane share of the split, in %. Adjusted by dragging the divider.
  const [ratio, setRatio] = useState(50);
  const splitBox = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [file, setFile] = useState<Viewed | null>(null);

  async function openFile(path: string) {
    if (!session) return;
    if (IMAGE_EXTS.has(path.split(".").at(-1)!.toLowerCase())) {
      setFile({ path, content: "", kind: "image" });
      return;
    }
    try {
      const f = await api<FileContent>(
        `/api/projects/${session.project}/file?path=${encodeURIComponent(path)}`,
      );
      setFile({ ...f, kind: "text" });
    } catch (e) {
      setFile({ path, content: `— ${(e as Error).message} —`, kind: "text" });
    }
  }

  async function openDiff(f: GitFileStatus) {
    if (!session) return;
    try {
      const d = await api<FileDiff>(
        `/api/projects/${session.project}/diff?path=${encodeURIComponent(f.path)}${f.staged ? "&staged=true" : ""}`,
      );
      setFile({ path: f.path, content: d.diff || "— no changes —", kind: "diff" });
    } catch (e) {
      setFile({ path: f.path, content: `— ${(e as Error).message} —`, kind: "diff" });
    }
  }

  async function uploadFile(f: File) {
    if (!session) return;
    await fetch(
      `/api/projects/${session.project}/file?path=${encodeURIComponent(f.name)}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: f },
    );
  }

  async function kill() {
    if (!session || !confirm("Kill this session? The tmux session and the agent inside it end.")) {
      return;
    }
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    navigate(`/p/${session.project}`);
  }

  async function deleteSession() {
    if (!session) return;
    const msg =
      session.status !== "done"
        ? "Kill and delete this session? The tmux session ends and it is removed from history."
        : "Delete this session from history?";
    if (!confirm(msg)) return;
    await api(`/api/sessions/${session.id}?purge=1`, { method: "DELETE" });
    navigate(`/p/${session.project}`);
  }

  const live = session != null && session.status !== "done";

  // hljs escapes the source; the produced HTML is only span tags with classes.
  const highlighted = useMemo(() => {
    if (!file || file.kind !== "text") return null;
    const lang = langFor(file.path);
    return lang ? hljs.highlight(file.content, { language: lang }).value : null;
  }, [file]);

  return (
    <>
      {/* Phone: exactly one visual viewport tall, and the document never
          scrolls — the terminal takes whatever room the keyboard leaves.
          Desktop keeps the ordinary scrolling page. */}
      <div className="flex h-[var(--vvh,100dvh)] flex-col overflow-hidden min-[800px]:h-auto min-[800px]:overflow-visible">
        <TopBar
          back={session ? `/p/${session.project}` : "/"}
          crumb={session ? [session.project, session.title] : []}
        />
        <main className="flex min-h-0 w-full flex-1 flex-col px-[18px] pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))] min-[800px]:pt-[18px] min-[800px]:pb-6">
          <div className="mb-2 flex flex-none items-center gap-2 min-[800px]:mb-3.5 min-[800px]:flex-wrap min-[800px]:gap-3">
            <StatusDot running={live} />
            <h1 className="min-w-0 truncate font-mono text-[14px] font-semibold min-[800px]:text-[16px]">
              {session?.title ?? "…"}
            </h1>
            {session && <AgentTag agent={session.agent} />}
            {session && (
              <StatusChip
                kind={session.status === "running" ? "run" : session.status === "waiting" ? "wait" : "idle"}
                label={live ? `${session.status} · ${durLabel(session.createdAt)}` : "done"}
              />
            )}
            {git && (
              <span className="hidden font-mono text-[12px] text-muted min-[800px]:inline">
                ⎇ {git.branch}
                {git.files.length > 0 ? "*" : ""}
              </span>
            )}
            {session && (
              <button
                onClick={() => setMenu(true)}
                aria-label="session actions"
                className="ml-auto flex-none rounded-[7px] border border-line bg-surface px-2.5 py-1 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
              >
                ⋯
              </button>
            )}
          </div>

          {syncNote && (
            <div className="mb-2 flex flex-none items-center gap-2 rounded-lg border border-wait/40 bg-wait/5 px-3 py-1.5 font-mono text-[12px] text-wait">
              <span className="min-w-0 flex-1 truncate">
                {syncNote.status === "failed" ? "could not sync" : "not synced"} to main:{" "}
                {syncNote.detail} · on ⎇ {syncNote.branch}
              </span>
              <button
                onClick={() => setSyncNote(null)}
                aria-label="dismiss"
                className="flex-none px-1 text-faint hover:text-text"
              >
                ✕
              </button>
            </div>
          )}

          {/* Phone: one strip for every pane. Desktop shows the sidebar and the
              terminal side by side instead, and picks companions in the box. */}
          <div className="mb-2 flex flex-none items-center gap-1.5 min-[800px]:hidden">
            <div role="tablist" className="flex min-w-0 gap-1.5 overflow-x-auto">
              <Tab on={pane === "tree"} onClick={() => setPane("tree")}>
                files
              </Tab>
              {live ? (
                (["agent", "shell", "browser"] as const).map((p) => (
                  <Tab
                    key={p}
                    on={pane === "term" && active === p}
                    onClick={() => {
                      setPane("term");
                      pick(p);
                    }}
                  >
                    {p === "agent" ? (session?.agent ?? "agent") : p}
                  </Tab>
                ))
              ) : (
                <Tab on={pane === "term"} onClick={() => setPane("term")}>
                  terminal
                </Tab>
              )}
            </div>
            <button
              onClick={() => setFull(true)}
              aria-label="full screen"
              className="ml-auto flex-none rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[12.5px] text-muted"
            >
              ⛶
            </button>
          </div>

          <div className="grid min-h-0 flex-1 items-stretch gap-3 min-[800px]:items-start min-[800px]:grid-cols-[250px_1fr]">
            <div
              className={`${pane === "tree" ? "flex" : "hidden min-[800px]:flex"} min-h-0 flex-col min-[800px]:h-[calc(var(--vvh,100dvh)-200px)]`}
            >
              <div role="tablist" className="mb-2 flex flex-none gap-1.5">
                {(["files", "git", "search"] as const).map((t) => (
                  <button
                    key={t}
                    role="tab"
                    aria-selected={side === t}
                    onClick={() => setSide(t)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                      side === t
                        ? "border-accent bg-surface-2 text-text"
                        : "border-line bg-surface text-muted"
                    }`}
                  >
                    {t}
                    {t === "git" && (git?.files.length ?? 0) > 0 && (
                      <span className="ml-1 text-wait">{git!.files.length}</span>
                    )}
                  </button>
                ))}
              </div>
              {side === "files" && (
                <FileTree
                  title={session ? `~/${session.project}` : "…"}
                  nodes={tree}
                  onOpenFile={openFile}
                  onUpload={async (f) => {
                    await uploadFile(f);
                    refreshTree();
                  }}
                />
              )}
              {side === "git" && session && (
                <GitPanel
                  project={session.project}
                  status={git}
                  onOpenDiff={openDiff}
                  onRefresh={refreshGit}
                />
              )}
              {side === "search" && session && (
                <SearchPanel project={session.project} onOpenFile={openFile} />
              )}
            </div>

            <div
              className={
                full
                  ? "fixed inset-x-0 top-[var(--vvt,0px)] z-50 flex h-[var(--vvh,100dvh)] flex-col overflow-hidden bg-term"
                  : `${pane === "term" ? "flex" : "hidden min-[800px]:flex"} min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-term min-[800px]:h-[calc(var(--vvh,100dvh)-200px)] min-[800px]:min-h-[380px]`
              }
            >
              {/* On a phone the pane strip above the box carries these controls,
                  so the row only costs rows there when it's the way out of full. */}
              <div
                className={`${full ? "flex" : "hidden min-[800px]:flex"} items-center gap-2.5 border-b border-line bg-surface px-3.5 py-[9px] font-mono text-[11.5px] text-faint`}
              >
                <span className="hidden text-muted min-[800px]:inline">
                  tmux · {session?.id ?? "…"}
                </span>
                {live && (
                  // Mobile: one pane at a time, these switch between them.
                  <span role="tablist" className="flex gap-1.5 min-[800px]:hidden">
                    {(["agent", "shell", "browser"] as const).map((p) => (
                      <button
                        key={p}
                        role="tab"
                        aria-selected={active === p}
                        onClick={() => pick(p)}
                        className={`rounded-[5px] border px-2 py-0.5 ${
                          active === p
                            ? "border-accent bg-surface-2 text-text"
                            : "border-line text-muted"
                        }`}
                      >
                        {p === "agent" ? (session?.agent ?? "agent") : p}
                      </button>
                    ))}
                  </span>
                )}
                <span className="ml-auto flex items-center gap-2">
                  {live && (
                    <span className="hidden gap-2 min-[800px]:flex">
                      <button
                        onClick={() => setShell((s) => !s)}
                        className={`rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${shell ? "border-accent text-text" : "border-line"}`}
                      >
                        {shell ? "✕ shell" : "▚ shell"}
                      </button>
                      <button
                        onClick={() => setBrowser((b) => !b)}
                        className={`rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${browser ? "border-accent text-text" : "border-line"}`}
                      >
                        {browser ? "✕ browser" : "◫ browser"}
                      </button>
                    </span>
                  )}
                  <button
                    onClick={() => setFull((f) => !f)}
                    className="rounded-[5px] border border-line px-2 py-0.5 hover:border-faint hover:text-text"
                  >
                    {full ? "✕ full" : "⛶ full"}
                  </button>
                  <span className="hidden min-[800px]:inline">{session?.agent}</span>
                </span>
              </div>
              {session &&
                (live ? (
                  <div ref={splitBox} className="flex min-h-0 flex-1 flex-col min-[800px]:flex-row">
                    <div
                      className={`${active === "agent" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 min-[800px]:flex ${shell || browser ? "min-[800px]:flex-none" : ""}`}
                      style={shell || browser ? { flexBasis: `${ratio}%` } : undefined}
                    >
                      <Terminal sessionId={session.id} project={session.project} />
                    </div>
                    {(shell || browser) && (
                      <div
                        onPointerDown={(e) => {
                          dragging.current = true;
                          e.currentTarget.setPointerCapture(e.pointerId);
                        }}
                        onPointerMove={(e) => {
                          if (!dragging.current || !splitBox.current) return;
                          const box = splitBox.current.getBoundingClientRect();
                          const pct = ((e.clientX - box.left) / box.width) * 100;
                          setRatio(Math.min(80, Math.max(20, pct)));
                        }}
                        onPointerUp={(e) => {
                          dragging.current = false;
                          e.currentTarget.releasePointerCapture(e.pointerId);
                        }}
                        title="drag to resize"
                        className="hidden w-1.5 flex-none cursor-col-resize touch-none bg-line hover:bg-accent/60 min-[800px]:block"
                      />
                    )}
                    {shell && (
                      <div
                        className={`${active === "shell" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 min-[800px]:flex`}
                      >
                        <Terminal sessionId={session.id} project={session.project} shell />
                      </div>
                    )}
                    {browser && (
                      <div
                        className={`${active === "browser" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 min-[800px]:flex ${shell ? "min-[800px]:border-l min-[800px]:border-line" : ""}`}
                      >
                        <BrowserPane sessionId={session.id} />
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center font-mono text-[13px] text-faint">
                    session ended {session.endedAt ? agoLabel(session.endedAt) : ""}
                  </div>
                ))}
            </div>
          </div>
        </main>
      </div>

      {menu && session && (
        <Sheet
          title={session.title}
          sub={`${session.agent} · ${live ? session.status : "done"}${git ? ` · ⎇ ${git.branch}${git.files.length > 0 ? "*" : ""}` : ""}`}
          onClose={() => setMenu(false)}
        >
          <div className="flex flex-col gap-2">
            {live && (
              <button
                onClick={() => {
                  setMenu(false);
                  void kill();
                }}
                className="w-full rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait"
              >
                kill session
              </button>
            )}
            <button
              onClick={() => {
                setMenu(false);
                void deleteSession();
              }}
              className="w-full rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait"
            >
              delete session
            </button>
          </div>
        </Sheet>
      )}

      {file && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => e.target === e.currentTarget && setFile(null)}
        >
          <div className="flex h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
              <img src={fileIcon(file.path.split("/").at(-1)!)} alt="" className="h-4 w-4 flex-none" />
              <span className="min-w-0 truncate">{file.path}</span>
              {file.kind === "diff" && <span className="flex-none text-[10px] text-faint">diff</span>}
              {session && file.kind !== "diff" && (
                <a
                  href={`/api/projects/${session.project}/raw?path=${encodeURIComponent(file.path)}&download=1`}
                  title="download"
                  className="ml-auto flex-none px-2 text-faint hover:text-text"
                >
                  ⤓
                </a>
              )}
              <button
                onClick={() => setFile(null)}
                className={`${file.kind === "diff" ? "ml-auto" : ""} flex-none px-2 text-faint hover:text-text`}
              >
                ✕
              </button>
            </div>
            {file.kind === "image" && session ? (
              <div className="flex flex-1 items-center justify-center overflow-auto bg-term p-4">
                <img
                  src={`/api/projects/${session.project}/raw?path=${encodeURIComponent(file.path)}`}
                  alt={file.path}
                  className="max-h-full max-w-full"
                />
              </div>
            ) : file.kind === "diff" ? (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {file.content.split("\n").map((line, i) => (
                  <div key={i} className={diffLineClass(line)}>
                    {line || " "}
                  </div>
                ))}
              </pre>
            ) : highlighted !== null ? (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                <code className="hljs !bg-transparent" dangerouslySetInnerHTML={{ __html: highlighted }} />
              </pre>
            ) : (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-text">
                {file.content}
              </pre>
            )}
          </div>
        </div>
      )}
    </>
  );
}
