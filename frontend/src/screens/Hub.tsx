import { useState } from "react";
import { useNavigate } from "react-router";
import type { PodFacts, Project } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Sheet from "../components/Sheet";

export default function Hub() {
  const navigate = useNavigate();
  const { data: projects, refresh } = usePoll<Project[]>("/api/projects");
  const { data: facts } = usePoll<PodFacts>("/api/facts", 30_000);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = projects?.reduce((n, p) => n + p.running, 0) ?? 0;
  const waiting = projects?.reduce((n, p) => n + p.waiting, 0) ?? 0;

  async function addProject() {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = value.includes("/")
        ? { mode: "clone", url: value }
        : { mode: "init", name: value };
      const { name } = await api<{ name: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setAdding(false);
      setInput("");
      refresh();
      navigate(`/p/${name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[1140px] px-[18px] pt-[22px] pb-[60px]">
        <div className="mb-5 flex items-end justify-between gap-4">
          <div>
            <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
              Projects
            </div>
            <h1 className="mb-1 text-[21px] font-semibold tracking-tight">
              {projects ? `${projects.length} repo${projects.length === 1 ? "" : "s"}` : "…"}
            </h1>
            <div className="text-sm text-muted">
              {running + waiting > 0
                ? [
                    running > 0 && `${running} session${running === 1 ? "" : "s"} running`,
                    waiting > 0 && `${waiting} waiting for input`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : "all quiet"}
            </div>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="flex-none rounded-lg bg-accent px-3.5 py-2 font-mono text-[13px] font-semibold text-[#16130a] hover:brightness-110"
          >
            + add project
          </button>
        </div>

        <div className="grid grid-cols-[repeat(auto-fill,minmax(290px,1fr))] gap-3">
          {(projects ?? []).map((p) => (
            <button
              key={p.name}
              onClick={() => navigate(`/p/${p.name}`)}
              className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-left transition hover:-translate-y-px hover:border-faint"
            >
              <div className="flex items-center gap-2.5">
                <StatusDot running={p.running + p.waiting > 0} />
                <span className="min-w-0 truncate font-mono text-[15px] font-semibold">
                  <span className="font-normal text-faint">~/</span>
                  {p.worktreeOf ? (
                    <>
                      <span className="text-muted">{p.worktreeOf}</span>
                      <span className="text-faint"> ⎇ </span>
                      {p.name.slice(p.worktreeOf.length + 2)}
                    </>
                  ) : (
                    p.name
                  )}
                </span>
                <span className="ml-auto">
                  {p.waiting > 0 ? (
                    <StatusChip kind="wait" label={`${p.waiting} waiting`} />
                  ) : p.running > 0 ? (
                    <StatusChip kind="run" label={`${p.running} running`} />
                  ) : (
                    <StatusChip kind="idle" label="idle" />
                  )}
                </span>
              </div>
              <div className="flex items-center gap-3.5 font-mono text-[11px] text-faint">
                <span>⎇ {p.branch}{p.dirty ? "*" : ""}</span>
                {p.agents.map((a) => (
                  <AgentTag key={a} agent={a} />
                ))}
                {p.running + p.waiting === 0 && (
                  <span>last session {agoLabel(p.lastSessionAt)}</span>
                )}
              </div>
            </button>
          ))}
          <button
            onClick={() => setAdding(true)}
            className="flex min-h-[118px] items-center justify-center rounded-xl border border-dashed border-line font-mono text-[13px] text-faint hover:text-muted"
          >
            + add project
          </button>
        </div>

        <div className="mt-10 flex flex-wrap gap-[18px] border-t border-line pt-4 font-mono text-[11px] text-faint">
          <span>single pod</span>
          <span>{projects?.length ?? 0} projects</span>
          <span>{running} running</span>
          {facts && (
            <>
              <span>
                data {gb(facts.diskTotal - facts.diskFree)}/{gb(facts.diskTotal)}
              </span>
              <span>
                mem {gb(facts.memUsed)}/{gb(facts.memTotal)}
              </span>
              <span>{facts.browsers} browser{facts.browsers === 1 ? "" : "s"}</span>
              {facts.docker?.map((d) => (
                <span key={d.type}>
                  docker {d.type.toLowerCase()} {d.size}
                  {d.reclaimable.startsWith("0B") ? "" : ` (${d.reclaimable.split(" ")[0]} reclaimable)`}
                </span>
              ))}
            </>
          )}
        </div>
      </main>

      {adding && (
        <Sheet
          title="Add project"
          sub="Paste a GitHub repo (owner/repo or https URL) to clone, or a plain name to init a local repo."
          onClose={() => setAdding(false)}
        >
          <input
            autoFocus
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProject()}
            placeholder="owner/repo or project-name"
            className="w-full rounded-[11px] border border-line bg-surface-2 px-3.5 py-3 font-mono text-[14px] outline-none placeholder:text-faint focus:border-accent"
          />
          {error && <div className="mt-2 font-mono text-[12px] text-wait">{error}</div>}
          <button
            onClick={addProject}
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-[#16130a] hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "working…" : input.includes("/") ? "clone" : "init"}
          </button>
        </Sheet>
      )}
    </>
  );
}
