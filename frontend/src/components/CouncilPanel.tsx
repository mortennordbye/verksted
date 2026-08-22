import { useState } from "react";
import type { AssistantEffort, CouncilColour, CouncilMember } from "../../../shared/api";
import { api, usePoll } from "../api";

/**
 * The council: who else answers, and what each of them may look at.
 *
 * A member is a file on the volume, so this is the whole of adding one — no
 * redeploy, the way a schedule works. What the form deliberately cannot offer
 * is a way to run a command: the denied built-ins are fixed in the backend, and
 * the tools listed here are only the ones no advisor can do harm with.
 *
 * The chair is shown but not editable here; it is the assistant, and it is
 * edited in the panel above.
 */
const EFFORTS: AssistantEffort[] = ["low", "medium", "high", "xhigh", "max"];
const COLOURS: CouncilColour[] = ["amber", "violet", "teal", "rose", "sky", "lime"];

const SWATCH: Record<CouncilColour, string> = {
  amber: "bg-member-amber",
  violet: "bg-member-violet",
  teal: "bg-member-teal",
  rose: "bg-member-rose",
  sky: "bg-member-sky",
  lime: "bg-member-lime",
};

const field =
  "rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent";

const blank = (id: string): CouncilMember => ({
  id,
  name: "",
  remit: "",
  persona: "",
  model: "",
  effort: "low",
  tools: [],
  web: false,
  colour: "sky",
  chair: false,
  enabled: true,
});

export default function CouncilPanel() {
  const { data, refresh } = usePoll<CouncilMember[]>("/api/council", 60_000);
  const { data: inventory } = usePoll<{ tools: { name: string; chairOnly: boolean }[] }>(
    "/api/council/tools",
    600_000,
  );
  const [editing, setEditing] = useState<CouncilMember | null>(null);
  const [error, setError] = useState<string | null>(null);

  const members = data ?? [];
  // Only what an advisor may hold: the rest are the chair's and would be
  // refused on save, so offering them would be offering a mistake.
  const offerable = (inventory?.tools ?? []).filter((t) => !t.chairOnly).map((t) => t.name);

  async function save() {
    if (!editing) return;
    setError(null);
    try {
      const { id, chair: _chair, ...body } = editing;
      await api(`/api/council/${id}`, { method: "PUT", body: JSON.stringify(body) });
      setEditing(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api(`/api/council/${id}`, { method: "DELETE" });
      setEditing(null);
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function add() {
    const id = window.prompt("A short id, lowercase, which is what @addresses them:")?.trim();
    if (!id) return;
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
      setError("an id is lowercase letters, digits and dashes, starting with a letter");
      return;
    }
    setEditing(blank(id));
  }

  return (
    <section className="mt-8">
      <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
        Council
      </div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">
        {members.length} in the room
      </h2>
      <div className="mb-3 text-sm text-muted">
        The chair answers every question and hands on the ones that belong to someone else. You can
        also address one directly by starting a message with their @id. None of them can edit files,
        run commands or change anything: that stays with the chair, which does it by starting a
        session you can watch.
      </div>

      {error && (
        <div className="mb-2 rounded-[9px] border border-fail/40 bg-fail/10 px-3 py-2 text-[13px]">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {members.map((m) => (
          <div
            key={m.id}
            className="flex flex-wrap items-center gap-2 rounded-[11px] border border-line bg-surface px-[15px] py-3"
          >
            <span className={`h-2.5 w-2.5 flex-none rounded-full ${SWATCH[m.colour]}`} />
            <span className="font-mono text-[13px]">{m.name}</span>
            <span className="font-mono text-[11px] text-faint">
              {m.chair ? "chair" : `@${m.id}`}
            </span>
            <span className="min-w-[12ch] flex-1 truncate text-[13px] text-muted">{m.remit}</span>
            {!m.enabled && <span className="font-mono text-[11px] text-wait">paused</span>}
            {!m.chair && (
              <button
                type="button"
                onClick={() => setEditing(m)}
                className="tap rounded-[7px] border border-line px-2.5 py-1 font-mono text-[12px] text-muted hover:border-line-strong"
              >
                edit
              </button>
            )}
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={add}
        className="tap mt-2 rounded-[7px] border border-dashed border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-line-strong"
      >
        + add someone
      </button>

      {editing && (
        <div className="mt-3 flex flex-col gap-2 rounded-[11px] border border-accent/40 bg-surface px-[15px] py-3">
          <div className="font-mono text-[11px] text-faint">@{editing.id}</div>
          <input
            className={field}
            placeholder="name"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          <input
            className={field}
            placeholder="one line: what they are for"
            value={editing.remit}
            onChange={(e) => setEditing({ ...editing, remit: e.target.value })}
          />
          <textarea
            className={`${field} min-h-[80px] resize-y`}
            placeholder="how they think, in their own words. Carried with every turn, so keep it short."
            value={editing.persona}
            onChange={(e) => setEditing({ ...editing, persona: e.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              className={`${field} w-[13ch]`}
              placeholder="model"
              value={editing.model}
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
            />
            <select
              className={field}
              value={editing.effort}
              onChange={(e) =>
                setEditing({ ...editing, effort: e.target.value as AssistantEffort })
              }
            >
              {EFFORTS.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <select
              className={field}
              value={editing.colour}
              onChange={(e) => setEditing({ ...editing, colour: e.target.value as CouncilColour })}
            >
              {COLOURS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div className="mt-1 text-[12px] text-muted">What they may look at</div>
          <div className="flex flex-wrap gap-1.5">
            {offerable.map((tool) => {
              const on = editing.tools.includes(tool);
              return (
                <button
                  key={tool}
                  type="button"
                  onClick={() =>
                    setEditing({
                      ...editing,
                      tools: on
                        ? editing.tools.filter((t) => t !== tool)
                        : [...editing.tools, tool],
                    })
                  }
                  aria-pressed={on}
                  className={`tap rounded-full border px-2.5 py-1 font-mono text-[11px] ${
                    on ? "border-accent/50 bg-accent-tint text-accent" : "border-line text-faint"
                  }`}
                >
                  {tool}
                </button>
              );
            })}
          </div>

          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={editing.web}
              onChange={(e) => setEditing({ ...editing, web: e.target.checked })}
            />
            can read the web
          </label>
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <input
              type="checkbox"
              checked={editing.enabled}
              onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })}
            />
            takes part in meetings
          </label>

          <div className="mt-1 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void save()}
              className="tap rounded-[7px] bg-accent px-3 py-1.5 font-mono text-[12px] font-medium text-on-accent"
            >
              save
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="tap rounded-[7px] border border-line px-3 py-1.5 font-mono text-[12px] text-muted"
            >
              cancel
            </button>
            {members.some((m) => m.id === editing.id) && (
              <button
                type="button"
                onClick={() => void remove(editing.id)}
                className="tap ml-auto rounded-[7px] border border-fail/40 px-3 py-1.5 font-mono text-[12px] text-fail"
              >
                remove
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
