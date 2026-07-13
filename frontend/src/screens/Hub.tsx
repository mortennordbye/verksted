import { useState } from "react";
import { useNavigate } from "react-router";
import type { Project } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Sheet from "../components/Sheet";

export default function Hub() {
  const navigate = useNavigate();
  const { data: projects, refresh } = usePoll<Project[]>("/api/projects");
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = projects?.reduce((n, p) => n + p.running, 0) ?? 0;

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
              {running > 0 ? `${running} session${running === 1 ? "" : "s"} running` : "all quiet"}
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
                <StatusDot running={p.running > 0} />
                <span className="font-mono text-[15px] font-semibold">
                  <span className="font-normal text-faint">~/</span>
                  {p.name}
                </span>
                <span className="ml-auto">
                  {p.running > 0 ? (
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
                {p.running === 0 && <span>last session {agoLabel(p.lastSessionAt)}</span>}
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
