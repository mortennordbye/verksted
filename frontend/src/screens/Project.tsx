import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import type {
  AgentName,
  CreatedSession,
  Project as ProjectInfo,
  Session,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import BranchControl from "../components/BranchControl";
import PrPanel from "../components/PrPanel";
import ActionsPanel from "../components/ActionsPanel";
import SchedulesPanel from "../components/SchedulesPanel";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Sheet, { focusIfPointerFine } from "../components/Sheet";
import { useConfirm } from "../useConfirm";

const AGENT_OPTIONS: { agent: AgentName; swatch: string; desc: string; cmd: string }[] = [
  { agent: "claude", swatch: "bg-claude", desc: "Claude Code · Max plan", cmd: "$ claude" },
  { agent: "antigravity", swatch: "bg-antigravity", desc: "Antigravity CLI", cmd: "$ agy" },
  { agent: "codex", swatch: "bg-codex", desc: "OpenAI Codex CLI", cmd: "$ codex" },
];

function SessionRow({ session, onDelete }: { session: Session; onDelete: () => void }) {
  const live = session.status !== "done";
  return (
    // The row was a div with an onClick: not focusable, not keyboard-reachable,
    // and cmd-click did nothing. The delete button is a sibling of the link
    // rather than inside it, since a button cannot nest in an anchor.
    <div
      className={`flex w-full items-center gap-3 rounded-[11px] border border-line bg-surface px-[15px] py-[13px] transition hover:border-faint ${live ? "" : "opacity-60"}`}
    >
      <Link to={`/s/${session.id}`} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <StatusDot running={live} />
        <div className="min-w-0 flex-1">
          <div className="overflow-hidden font-mono text-[13.5px] text-ellipsis whitespace-nowrap">
            {session.title}
          </div>
          <div className="mt-0.5 flex items-center gap-2.5 text-[12px] text-faint">
            <AgentTag agent={session.agent} />
            <span>tmux: {session.id}</span>
            <span>{agoLabel(live ? session.createdAt : session.endedAt)}</span>
          </div>
          {/* What the agent said about its own work, when it said anything —
              far more use on a row than "done". */}
          {session.report && (
            <div
              className={`mt-1 truncate text-[12px] ${
                session.outcome === "failed"
                  ? "text-fail"
                  : session.outcome === "attention"
                    ? "text-wait"
                    : "text-muted"
              }`}
            >
              {session.report}
            </div>
          )}
        </div>
      </Link>
      <StatusChip
        kind={session.status === "running" ? "run" : session.status === "waiting" ? "wait" : "idle"}
        label={session.status}
      />
      {/* Sits inside the row's own tap area, and kills a running agent — the
          worst mis-tap in the app. A real target size and a gap from the row
          edge are the cheap half of the fix; the confirm is the other half. */}
      <button
        onClick={onDelete}
        title="delete session"
        aria-label={`delete session ${session.title}`}
        className="tap-sq ml-1 flex flex-none items-center justify-center rounded-[7px] border border-line px-2 py-1 font-mono text-[12px] text-faint hover:border-wait hover:text-wait"
      >
        ✕
      </button>
    </div>
  );
}

export default function Project() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const {
    data: sessions,
    loading: sessionsLoading,
    notFound,
    refresh: refreshSessions,
  } = usePoll<Session[]>(`/api/projects/${name}/sessions`);
  const { data: projects, refresh: refreshProjects } = usePoll<ProjectInfo[]>(
    "/api/projects",
    10_000,
  );
  const info = projects?.find((p) => p.name === name);
  const [picking, setPicking] = useState(false);
  const [resume, setResume] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [branching, setBranching] = useState(false);
  const [branch, setBranch] = useState("");
  const [branchBusy, setBranchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"sessions" | "prs" | "actions" | "schedules">("sessions");
  const [confirm, confirmDialog] = useConfirm();

  const active = sessions?.filter((s) => s.status !== "done") ?? [];
  const recent = sessions?.filter((s) => s.status === "done") ?? [];

  async function newWorktree() {
    const value = branch.trim();
    if (!value || branchBusy) return;
    setBranchBusy(true);
    setError(null);
    try {
      const created = await api<{ name: string }>(`/api/projects/${name}/worktrees`, {
        method: "POST",
        body: JSON.stringify({ branch: value }),
      });
      setBranching(false);
      setBranch("");
      void navigate(`/p/${created.name}`);
    } catch (e) {
      setError((e as Error).message);
      setBranching(false);
    } finally {
      setBranchBusy(false);
    }
  }

  async function deleteSession(s: Session) {
    const live = s.status !== "done";
    const ok = await confirm({
      title: live ? `Kill and delete ${s.title}?` : `Delete ${s.title}?`,
      body: live
        ? "The tmux session and the agent inside it end, and it is removed from history. This cannot be undone."
        : "It is removed from history. This cannot be undone.",
      action: live ? "kill and delete" : "delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api(`/api/sessions/${s.id}?purge=1`, { method: "DELETE" });
      refreshSessions();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function deleteProject() {
    if (deleting) return;
    setDeleting(true);
    try {
      await api(`/api/projects/${name}`, { method: "DELETE" });
      void navigate("/");
    } catch (e) {
      setError((e as Error).message);
      setConfirmingDelete(false);
      setDeleting(false);
    }
  }

  async function newSession(agent: AgentName) {
    try {
      const session = await api<CreatedSession>(`/api/projects/${name}/sessions`, {
        method: "POST",
        body: JSON.stringify({ agent, resume }),
      });
      // The session screen reports it when the repo could not be put on an
      // up-to-date main first.
      void navigate(`/s/${session.id}`, { state: { sync: session.sync } });
    } catch (e) {
      setError((e as Error).message);
      setPicking(false);
    }
  }

  // A deleted or mistyped project used to render as an ordinary project with an
  // empty session list, which reads as "this project is idle".
  if (notFound) {
    return (
      <>
        <TopBar back="/" crumb={name ? [name] : []} />
        <main className="mx-auto max-w-[700px] px-[18px] pt-[22px]">
          <h1 className="mb-2 text-[21px] font-semibold tracking-tight">no such project</h1>
          <p className="text-sm text-muted">
            <code className="font-mono text-[12.5px]">{name}</code> is not a repo under the pod's
            repos directory.
          </p>
        </main>
      </>
    );
  }

  return (
    <>
      <TopBar back="/" crumb={name ? [name] : []} />
      <main className="mx-auto max-w-[1140px] px-[18px] pt-[22px] pb-[60px]">
        <div className="mb-[18px] flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
              Project
            </div>
            <h1 className="mb-1 font-mono text-[21px] font-semibold tracking-tight">~/{name}</h1>
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
              {info ? (
                <>
                  <BranchControl
                    project={name!}
                    branch={info.branch}
                    onChanged={refreshProjects}
                    className="rounded-md border border-line bg-surface px-2 py-0.5 font-mono text-[13px] hover:border-faint hover:text-text"
                  />
                  <span>
                    {info.dirty ? "dirty" : "clean"}
                    {info.worktreeOf ? ` · worktree of ${info.worktreeOf}` : ""}
                  </span>
                </>
              ) : (
                "…"
              )}
            </div>
          </div>
          <div className="flex flex-none gap-2">
            {info && !info.worktreeOf && (
              <button
                onClick={() => setBranching(true)}
                className="rounded-lg border border-line bg-surface px-3.5 py-2 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
              >
                ⎇ new worktree
              </button>
            )}
            <button
              onClick={() => setPicking(true)}
              className="rounded-lg bg-accent px-3.5 py-2 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110"
            >
              ▸ new session
            </button>
          </div>
        </div>

        {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

        {/* An unselected panel is unmounted, so its poll does not run. */}
        <div role="tablist" className="mt-6 mb-4 flex gap-1.5 border-b border-line pb-3">
          {(["sessions", "prs", "actions", "schedules"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                tab === t
                  ? "border-accent bg-surface-2 text-text"
                  : "border-line bg-surface text-muted"
              }`}
            >
              {t}
              {t === "sessions" && active.length > 0 && (
                <span className="ml-1 text-run">{active.length}</span>
              )}
            </button>
          ))}
        </div>

        {tab === "sessions" && (
          <>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Active
            </div>
            <div className="flex flex-col gap-2.5">
              {active.map((s) => (
                <SessionRow key={s.id} session={s} onDelete={() => deleteSession(s)} />
              ))}
              {active.length === 0 && (
                <div className="font-mono text-[12.5px] text-faint">
                  {sessionsLoading ? "loading…" : "no active sessions"}
                </div>
              )}
            </div>

            {recent.length > 0 && (
              <>
                <div className="mt-6 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
                  Recent
                </div>
                <div className="flex flex-col gap-2.5">
                  {recent.map((s) => (
                    <SessionRow key={s.id} session={s} onDelete={() => deleteSession(s)} />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {tab === "prs" && <PrPanel project={name!} onChanged={refreshProjects} />}
        {tab === "actions" && <ActionsPanel project={name!} />}
        {tab === "schedules" && <SchedulesPanel project={name} />}

        <div className="mt-10 border-t border-line pt-4">
          <button
            onClick={() => setConfirmingDelete(true)}
            className="font-mono text-[12px] text-faint hover:text-wait"
          >
            delete project…
          </button>
        </div>
      </main>

      {picking && (
        <Sheet
          title={`New session in ~/${name}`}
          sub="Pick an agent. The repo moves to an up-to-date main first (skipped when it is dirty or a worktree), then the agent runs in a fresh tmux session on the pod."
          onClose={() => setPicking(false)}
        >
          <div className="flex flex-col gap-2">
            {AGENT_OPTIONS.map((o) => (
              <button
                key={o.agent}
                onClick={() => newSession(o.agent)}
                className="flex items-center gap-[13px] rounded-[11px] border border-line bg-surface-2 px-3.5 py-[13px] text-left hover:border-faint"
              >
                <span className={`h-3 w-3 flex-none rounded-[3px] ${o.swatch}`} />
                <span>
                  <span className="font-mono text-[14px] font-semibold">{o.agent}</span>
                  <br />
                  <span className="text-[12px] text-muted">{o.desc}</span>
                </span>
                <span className="ml-auto font-mono text-[11px] text-faint">
                  {o.agent === "claude" && resume ? "$ claude --continue" : o.cmd}
                </span>
              </button>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2.5 font-mono text-[12px] text-muted">
            <input
              type="checkbox"
              checked={resume}
              onChange={(e) => setResume(e.target.checked)}
              className="accent-accent"
            />
            resume the previous conversation (claude only)
          </label>
        </Sheet>
      )}

      {branching && (
        <Sheet
          title={`New worktree in ~/${name}`}
          sub="Runs sessions on their own branch in a linked git worktree, side by side with the main checkout. The branch is created from HEAD if it doesn't exist."
          onClose={() => setBranching(false)}
        >
          <input
            ref={focusIfPointerFine}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && newWorktree()}
            placeholder="branch name (e.g. feature-x)"
            className="w-full rounded-[11px] border border-line bg-surface-2 px-3.5 py-3 font-mono text-[14px] outline-none placeholder:text-faint focus:border-accent"
          />
          <button
            onClick={newWorktree}
            disabled={branchBusy || !branch.trim()}
            className="mt-3 w-full rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {branchBusy ? "working…" : "create worktree"}
          </button>
        </Sheet>
      )}

      {confirmingDelete && (
        <Sheet
          title={`Delete ~/${name}`}
          sub={`Kills ${active.length > 0 ? `${active.length} running session${active.length === 1 ? "" : "s"}` : "any sessions"} and removes the ${info?.worktreeOf ? `worktree (the branch stays in ~/${info.worktreeOf})` : "repo directory, including its worktrees,"} from the pod${info?.dirty ? " — including uncommitted changes" : ""}. A GitHub remote is not touched.`}
          onClose={() => !deleting && setConfirmingDelete(false)}
        >
          <button
            onClick={deleteProject}
            disabled={deleting}
            className="w-full rounded-lg border border-wait px-3.5 py-2.5 font-mono text-[13px] font-semibold text-wait hover:bg-wait/10 disabled:opacity-50"
          >
            {deleting ? "deleting…" : `delete ~/${name}`}
          </button>
        </Sheet>
      )}
      {confirmDialog}
    </>
  );
}
