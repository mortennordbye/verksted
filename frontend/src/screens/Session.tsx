import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { FileContent, Session as SessionInfo, TreeNode } from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
import FileTree from "../components/FileTree";

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: session } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const { data: tree } = usePoll<TreeNode[]>(
    session ? `/api/projects/${session.project}/tree` : null,
    8_000,
  );
  const [pane, setPane] = useState<"tree" | "term">("term");
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

  const running = session?.status === "running";

  return (
    <>
      <TopBar
        back={session ? `/p/${session.project}` : "/"}
        crumb={session ? [session.project, session.title] : []}
      />
      <main className="mx-auto max-w-[1140px] px-[18px] pt-[22px] pb-[60px]">
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
          {running && (
            <button
              onClick={kill}
              className="ml-auto rounded-[7px] border border-line bg-surface px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait"
            >
              kill session
            </button>
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
            <FileTree
              title={session ? `~/${session.project}` : "…"}
              nodes={tree}
              onOpenFile={openFile}
            />
          </div>

          <div
            className={`${pane === "term" ? "flex" : "hidden min-[800px]:flex"} h-[calc(100dvh-220px)] min-h-[380px] flex-col overflow-hidden rounded-xl border border-line bg-term min-[800px]:h-[68vh]`}
          >
            <div className="flex items-center gap-2.5 border-b border-line bg-surface px-3.5 py-[9px] font-mono text-[11.5px] text-faint">
              <span className="text-muted">tmux · {session?.id ?? "…"}</span>
              <span className="ml-auto">{session?.agent}</span>
            </div>
            {session &&
              (running ? (
                <Terminal sessionId={session.id} />
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
            <div className="flex items-center border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
              {file.path}
              <button onClick={() => setFile(null)} className="ml-auto px-2 text-faint hover:text-text">
                ✕
              </button>
            </div>
            <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-text">
              {file.content}
            </pre>
          </div>
        </div>
      )}
    </>
  );
}
