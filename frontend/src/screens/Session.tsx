import { useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.css";
import type { FileContent, GitStatus, Session as SessionInfo, TreeNode } from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
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

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const { data: tree } = usePoll<TreeNode[]>(
    session ? `/api/projects/${session.project}/tree` : null,
    8_000,
  );
  const { data: git } = usePoll<GitStatus>(
    session ? `/api/projects/${session.project}/git` : null,
    8_000,
  );
  const [pane, setPane] = useState<"tree" | "term">("term");
  const [side, setSide] = useState<"files" | "git" | "search">("files");
  const [split, setSplit] = useState(false);
  const [full, setFull] = useState(false);
  // Agent-pane share of the split, in %. Adjusted by dragging the divider.
  const [ratio, setRatio] = useState(50);
  const splitBox = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [file, setFile] = useState<FileContent | null>(null);

  async function openFile(path: string) {
    if (!session) return;
    try {
      setFile(
        await api<FileContent>(
          `/api/projects/${session.project}/file?path=${encodeURIComponent(path)}`,
        ),
      );
    } catch (e) {
      setFile({ path, content: `— ${(e as Error).message} —` });
    }
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
      session.status === "running"
        ? "Kill and delete this session? The tmux session ends and it is removed from history."
        : "Delete this session from history?";
    if (!confirm(msg)) return;
    await api(`/api/sessions/${session.id}?purge=1`, { method: "DELETE" });
    navigate(`/p/${session.project}`);
  }

  const running = session?.status === "running";

  // hljs escapes the source; the produced HTML is only span tags with classes.
  const highlighted = useMemo(() => {
    if (!file) return null;
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
          <StatusDot running={running} />
          <h1 className="font-mono text-[16px] font-semibold">{session?.title ?? "…"}</h1>
          {session && <AgentTag agent={session.agent} />}
          {session && (
            <StatusChip
              kind={running ? "run" : "idle"}
              label={running ? `running · ${durLabel(session.createdAt)}` : "done"}
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
              {running && (
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
              />
            )}
            {side === "git" && <GitPanel status={git} onOpenFile={openFile} />}
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
              <span className="text-muted">tmux · {session?.id ?? "…"}</span>
              <span className="ml-auto flex items-center gap-2">
                {running && (
                  <button
                    onClick={() => setSplit((s) => !s)}
                    className="rounded-[5px] border border-line px-2 py-0.5 hover:border-faint hover:text-text"
                  >
                    {split ? "✕ shell" : "▚ shell"}
                  </button>
                )}
                <button
                  onClick={() => setFull((f) => !f)}
                  className="rounded-[5px] border border-line px-2 py-0.5 hover:border-faint hover:text-text"
                >
                  {full ? "✕ full" : "⛶ full"}
                </button>
                <span>{session?.agent}</span>
              </span>
            </div>
            {session &&
              (running ? (
                <div ref={splitBox} className="flex min-h-0 flex-1 flex-col min-[800px]:flex-row">
                  <div
                    className={`flex min-h-0 min-w-0 ${split ? "min-[800px]:flex-none" : ""} flex-1`}
                    style={split ? { flexBasis: `${ratio}%` } : undefined}
                  >
                    <Terminal sessionId={session.id} />
                  </div>
                  {split && (
                    <>
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
                      <div className="flex min-h-0 min-w-0 flex-1 border-t border-line min-[800px]:border-t-0">
                        <Terminal sessionId={session.id} shell />
                      </div>
                    </>
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
              {file.path}
              <button onClick={() => setFile(null)} className="ml-auto px-2 text-faint hover:text-text">
                ✕
              </button>
            </div>
            {highlighted !== null ? (
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
