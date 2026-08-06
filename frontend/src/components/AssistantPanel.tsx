import { useEffect, useState } from "react";
import type { AssistantConfig } from "../../../shared/api";
import { api, usePoll } from "../api";

/**
 * Who the assistant is, and what it costs to run.
 *
 * The model is free text rather than a dropdown: aliases come and go, and a
 * settings page that cannot name a new one is worse than one that lets a typo
 * through and says so on the next turn.
 */
const EFFORTS: AssistantConfig["effort"][] = ["low", "medium", "high", "xhigh", "max"];

export default function AssistantPanel() {
  const { data } = usePoll<AssistantConfig>("/api/assistant/config", 60_000);
  const [draft, setDraft] = useState<AssistantConfig | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Adopt the server's answer once, then leave the fields alone: a poll landing
  // mid-sentence must not overwrite what is being typed.
  useEffect(() => {
    setDraft((d) => d ?? data);
  }, [data]);

  async function save() {
    if (!draft) return;
    setError(null);
    try {
      setDraft(
        await api<AssistantConfig>("/api/assistant/config", {
          method: "PUT",
          body: JSON.stringify(draft),
        }),
      );
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const field =
    "rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent";

  return (
    <section className="mt-8">
      <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
        Assistant
      </div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">
        {draft?.name?.trim() || "Unnamed"}
      </h2>
      <div className="mb-3 text-sm text-muted">
        Its name, what it runs on, and any standing orders. Changes apply to the next thing you say,
        not to the turn in flight.
      </div>

      <div className="flex flex-col gap-2 rounded-[11px] border border-line bg-surface px-[15px] py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={draft?.name ?? ""}
            onChange={(e) => setDraft((d) => d && { ...d, name: e.target.value })}
            aria-label="assistant name"
            placeholder="name"
            className={`w-[150px] ${field}`}
          />
          <input
            value={draft?.model ?? ""}
            onChange={(e) => setDraft((d) => d && { ...d, model: e.target.value })}
            aria-label="model"
            placeholder="model"
            className={`w-[150px] ${field}`}
          />
          <select
            value={draft?.effort ?? "low"}
            onChange={(e) =>
              setDraft((d) => d && { ...d, effort: e.target.value as AssistantConfig["effort"] })
            }
            aria-label="effort"
            className={field}
          >
            {EFFORTS.map((f) => (
              <option key={f} value={f}>
                {f} effort
              </option>
            ))}
          </select>
        </div>

        <textarea
          value={draft?.instructions ?? ""}
          onChange={(e) => setDraft((d) => d && { ...d, instructions: e.target.value })}
          rows={4}
          aria-label="standing orders"
          placeholder="Standing orders. Anything here overrides how it normally behaves, and is carried with every turn, so keep it short."
          className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[13px] outline-none placeholder:text-faint focus:border-accent"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={() => void save()}
            disabled={!draft}
            className="rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            save
          </button>
          {saved && <span className="font-mono text-[11px] text-run">saved</span>}
          {error && <span className="font-mono text-[11px] text-fail">{error}</span>}
          <span className="ml-auto font-mono text-[11px] text-faint">
            a bigger model follows instructions more closely and costs more
          </span>
        </div>
      </div>
    </section>
  );
}
