import { useState } from "react";
import type { Settings as SettingsInfo, SettingVar } from "../../../shared/api";
import { api, usePoll } from "../api";
import TopBar from "../components/TopBar";
import { StatusChip } from "../components/StatusChip";

function sourceChip(source: SettingVar["source"]) {
  if (source === "env") return <StatusChip kind="run" label="env" />;
  if (source === "settings") return <StatusChip kind="wait" label="settings" />;
  return <StatusChip kind="idle" label="unset" />;
}

export default function Settings() {
  const { data, refresh } = usePoll<SettingsInfo>("/api/settings", 30_000);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function save(vars: Record<string, string | null>) {
    setError(null);
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ vars }) });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveDraft(key: string) {
    const value = drafts[key]?.trim();
    if (!value) return;
    await save({ [key]: value });
    setDrafts((d) => ({ ...d, [key]: "" }));
  }

  async function addVar() {
    const key = newKey.trim();
    if (!key) return;
    await save({ [key]: drafts[key]?.trim() || null });
    setNewKey("");
  }

  return (
    <>
      <TopBar back="/" crumb={["settings"]} />
      <main className="mx-auto max-w-[760px] px-[18px] pt-[22px] pb-[60px]">
        <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
          Settings
        </div>
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">Environment</h1>
        <div className="mb-6 text-sm text-muted">
          Variables reach the agent CLIs inside new tmux sessions. Values are write-only:
          the page shows where a variable is defined, never what it contains.
        </div>

        {error && <div className="mb-3 font-mono text-[12px] text-wait">{error}</div>}

        <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Server · from the deployment (read-only)
        </div>
        <div className="mb-7 overflow-hidden rounded-xl border border-line">
          {Object.entries(data?.server ?? {}).map(([key, value]) => (
            <div
              key={key}
              className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-[15px] py-2.5 font-mono text-[12.5px] last:border-b-0"
            >
              <span className="text-text">{key}</span>
              <span className="ml-auto text-muted">{value}</span>
            </div>
          ))}
        </div>

        <div className="mb-2.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
          Agent environment
        </div>
        <div className="flex flex-col gap-2">
          {(data?.vars ?? []).map((v) => (
            <div
              key={v.key}
              className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5"
            >
              <span className="font-mono text-[12.5px]">{v.key}</span>
              {sourceChip(v.source)}
              <input
                value={drafts[v.key] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [v.key]: e.target.value }))}
                onKeyDown={(e) => e.key === "Enter" && saveDraft(v.key)}
                placeholder={
                  v.source === "unset" ? "enter value…" : "enter new value to replace…"
                }
                className="min-w-[160px] flex-1 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
              />
              {drafts[v.key]?.trim() && (
                <button
                  onClick={() => saveDraft(v.key)}
                  className="rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-[#16130a] hover:brightness-110"
                >
                  save
                </button>
              )}
              {v.source === "settings" && (
                <button
                  onClick={() => save({ [v.key]: null })}
                  title="remove the stored value"
                  className="rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-wait hover:text-wait"
                >
                  clear
                </button>
              )}
            </div>
          ))}

          <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
            <input
              value={newKey}
              onChange={(e) => setNewKey(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && addVar()}
              placeholder="NEW_VARIABLE"
              className="w-[200px] rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            <input
              value={drafts[newKey.trim()] ?? ""}
              onChange={(e) =>
                setDrafts((d) => ({ ...d, [newKey.trim()]: e.target.value }))
              }
              onKeyDown={(e) => e.key === "Enter" && addVar()}
              placeholder="value"
              className="min-w-[160px] flex-1 rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
            />
            <button
              onClick={addVar}
              disabled={!newKey.trim() || !drafts[newKey.trim()]?.trim()}
              className="rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-[#16130a] hover:brightness-110 disabled:opacity-50"
            >
              add
            </button>
          </div>
        </div>

        <div className="mt-5 text-[13px] text-muted">
          Settings-page values persist on the data volume and take precedence over
          deployment env vars. Changes apply to sessions started afterwards.
        </div>
      </main>
    </>
  );
}
