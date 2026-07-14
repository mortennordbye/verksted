import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.css";
import type {
  FileDiff,
  FileContent,
  GitFileStatus,
  GitStatus,
  Session as SessionInfo,
  TreeNode,
} from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
import BrowserPane from "../components/BrowserPane";
import FileTree from "../components/FileTree";
import GitPanel from "../components/GitPanel";
import SearchPanel from "../components/SearchPanel";
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

function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-run";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-claude";
  if (line.startsWith("@@")) return "text-accent";
  if (/^(diff |index |\+\+\+|---)/.test(line)) return "text-faint";
  return "text-muted";
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
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
      <TopBar
        back={session ? `/p/${session.project}` : "/"}
        crumb={session ? [session.project, session.title] : []}
      />
      <main className="w-full px-[18px] pt-[18px] pb-6">
        <div className="mb-3.5 flex flex-wrap items-center gap-3">
          <StatusDot running={live} />
          <h1 className="font-mono text-[16px] font-semibold">{session?.title ?? "…"}</h1>
          {session && <AgentTag agent={session.agent} />}
          {session && (
            <StatusChip
              kind={session.status === "running" ? "run" : session.status === "waiting" ? "wait" : "idle"}
              label={live ? `${session.status} · ${durLabel(session.createdAt)}` : "done"}
            />
          )}
          {git && (
            <span className="font-mono text-[12px] text-muted">
              ⎇ {git.branch}
              {git.files.length > 0 ? "*" : ""}
            </span>
          )}
          {session && (
            <span className="ml-auto flex gap-2">
              {live && (
                <button
                  onClick={kill}
                  className="rounded-[7px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait"
                >
                  kill session
                </button>
              )}
              <button
                onClick={deleteSession}
                className="rounded-[7px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait"
              >
                delete session
              </button>
            </span>
          )}
        </div>

        <div role="tablist" className="mb-3 flex gap-1.5 min-[800px]:hidden">
          {(["tree", "term"] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={`rounded-lg border px-3.5 py-2 font-mono text-[12.5px] ${
                pane === p
                  ? "border-accent bg-surface-2 text-text"
                  : "border-line bg-surface text-muted"
              }`}
            >
              {p === "tree" ? "files" : "terminal"}
            </button>
          ))}
        </div>

        <div className="grid items-start gap-3 min-[800px]:grid-cols-[250px_1fr]">
          <div className={pane === "tree" ? "" : "hidden min-[800px]:block"}>
            <div role="tablist" className="mb-2 flex gap-1.5">
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
                ? "fixed inset-0 z-50 flex flex-col overflow-hidden bg-term"
                : `${pane === "term" ? "flex" : "hidden min-[800px]:flex"} h-[calc(100dvh-200px)] min-h-[380px] flex-col overflow-hidden rounded-xl border border-line bg-term`
            }
          >
            <div className="flex items-center gap-2.5 border-b border-line bg-surface px-3.5 py-[9px] font-mono text-[11.5px] text-faint">
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
                    <Terminal sessionId={session.id} />
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
                      <Terminal sessionId={session.id} shell />
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
