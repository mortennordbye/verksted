import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { AgentName, Project as ProjectInfo, Session } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Sheet from "../components/Sheet";

const AGENT_OPTIONS: { agent: AgentName; swatch: string; desc: string; cmd: string }[] = [
  { agent: "claude", swatch: "bg-claude", desc: "Claude Code · Max plan", cmd: "$ claude" },
  { agent: "antigravity", swatch: "bg-antigravity", desc: "Antigravity CLI", cmd: "$ agy" },
  { agent: "codex", swatch: "bg-codex", desc: "OpenAI Codex CLI", cmd: "$ codex" },
];

function SessionRow({ session, onClick }: { session: Session; onClick: () => void }) {
  const running = session.status === "running";
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-3 rounded-[11px] border border-line bg-surface px-[15px] py-[13px] text-left transition hover:border-faint ${running ? "" : "opacity-60"}`}
    >
      <StatusDot running={running} />
      <div className="min-w-0 flex-1">
        <div className="overflow-hidden font-mono text-[13.5px] text-ellipsis whitespace-nowrap">
          {session.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2.5 text-[12px] text-faint">
          <AgentTag agent={session.agent} />
          <span>tmux: {session.id}</span>
          <span>{agoLabel(running ? session.createdAt : session.endedAt)}</span>
        </div>
      </div>
      <StatusChip kind={running ? "run" : "idle"} label={running ? "running" : "done"} />
    </button>
  );
}

export default function Project() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { data: sessions } = usePoll<Session[]>(`/api/projects/${name}/sessions`);
  const { data: projects } = usePoll<ProjectInfo[]>("/api/projects", 10_000);
  const info = projects?.find((p) => p.name === name);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const active = sessions?.filter((s) => s.status === "running") ?? [];
  const recent = sessions?.filter((s) => s.status === "done") ?? [];

  async function newSession(agent: AgentName) {
    try {
      const session = await api<Session>(`/api/projects/${name}/sessions`, {
        method: "POST",
        body: JSON.stringify({ agent }),
      });
      navigate(`/s/${session.id}`);
    } catch (e) {
      setError((e as Error).message);
      setPicking(false);
    }
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
            <div className="text-sm text-muted">
              {info ? `⎇ ${info.branch} · ${info.dirty ? "dirty" : "clean"}` : "…"}
            </div>
          </div>
          <button
            onClick={() => setPicking(true)}
            className="flex-none rounded-lg bg-accent px-3.5 py-2 font-mono text-[13px] font-semibold text-[#16130a] hover:brightness-110"
          >
            ▸ new session
          </button>
        </div>

        {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

        <div className="mt-6 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Active
        </div>
        <div className="flex flex-col gap-2.5">
          {active.map((s) => (
            <SessionRow key={s.id} session={s} onClick={() => navigate(`/s/${s.id}`)} />
          ))}
          {active.length === 0 && (
            <div className="font-mono text-[12.5px] text-faint">no active sessions</div>
          )}
        </div>

        {recent.length > 0 && (
          <>
            <div className="mt-6 mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Recent
            </div>
            <div className="flex flex-col gap-2.5">
              {recent.map((s) => (
                <SessionRow key={s.id} session={s} onClick={() => navigate(`/s/${s.id}`)} />
              ))}
            </div>
          </>
        )}
      </main>

      {picking && (
        <Sheet
          title={`New session in ~/${name}`}
          sub="Pick an agent. It runs in a fresh tmux session on the pod."
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
                <span className="ml-auto font-mono text-[11px] text-faint">{o.cmd}</span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </>
  );
}
