import { useEffect, useState } from "react";
import type {
  AssistantEffort,
  AssistantVoices,
  CouncilColour,
  CouncilMember,
} from "../../../shared/api";
import { api, usePoll } from "../api";
import { audioPlayer, voiceLabel } from "../useSpeech";

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

const TEXT: Record<CouncilColour, string> = {
  amber: "text-member-amber",
  violet: "text-member-violet",
  teal: "text-member-teal",
  rose: "text-member-rose",
  sky: "text-member-sky",
  lime: "text-member-lime",
};

const RULE: Record<CouncilColour, string> = {
  amber: "border-member-amber/40",
  violet: "border-member-violet/40",
  teal: "border-member-teal/40",
  rose: "border-member-rose/40",
  sky: "border-member-sky/40",
  lime: "border-member-lime/40",
};

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

/**
 * One line in this advisor's own voice, so the sample is a sample of them.
 *
 * A shared sentence would tell you what the model sounds like; what you want to
 * know is what *this one* sounds like saying the kind of thing it says, which
 * is the same reason each of them has a persona at all.
 */
function sampleFor(m: CouncilMember): string {
  const first = m.persona
    .split(/(?<=[.!?])\s+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 20);
  return first ?? `I am ${m.name || "one of the council"}. I watch ${m.remit || "this bench"}.`;
}

/** How this one talks, and a button to hear it. */
function Voice({ member, voices }: { member: CouncilMember; voices: string[] }) {
  const [playing, setPlaying] = useState(false);
  if (!voices.length) return null;

  async function hear() {
    if (playing) return;
    setPlaying(true);
    try {
      const res = await fetch("/api/assistant/speak", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: sampleFor(member).slice(0, 300),
          ...(member.voice ? { voice: member.voice } : {}),
        }),
      });
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      const audio = audioPlayer();
      audio.src = url;
      // This is a click, so playing here also unlocks the element for the
      // replies that arrive later without one.
      await audio.play().catch(() => undefined);
      audio.onended = () => URL.revokeObjectURL(url);
    } finally {
      setPlaying(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void hear()}
      disabled={playing}
      className="tap rounded-full border border-line px-2.5 py-1 font-mono text-[11px] text-faint hover:border-line-strong disabled:opacity-50"
    >
      {playing ? "…" : "▸"} {member.voice ? voiceLabel(member.voice) : "the default voice"}
    </button>
  );
}

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
  voice: "",
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
  const [voices, setVoices] = useState<string[]>([]);

  useEffect(() => {
    void api<AssistantVoices>("/api/assistant/voices")
      .then((v) => setVoices(v.voices))
      .catch(() => {
        // No voice model on this pod: the roster simply says nothing about how
        // anyone sounds, rather than offering a control that cannot work.
      });
  }, []);

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

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {members.map((m) => (
          <div
            key={m.id}
            className={`flex flex-col gap-2 rounded-[11px] border border-l-2 bg-surface px-[15px] py-3 ${
              m.enabled ? RULE[m.colour] : "border-line opacity-60"
            }`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2.5 w-2.5 flex-none rounded-full ${SWATCH[m.colour]}`} />
              <span className={`font-mono text-[13px] ${TEXT[m.colour]}`}>{m.name}</span>
              <span className="font-mono text-[11px] text-faint">
                {m.chair ? "chair" : `@${m.id}`}
              </span>
              {!m.enabled && <span className="font-mono text-[11px] text-wait">paused</span>}
              {!m.chair && (
                <button
                  type="button"
                  onClick={() => setEditing(m)}
                  className="tap ml-auto rounded-[7px] border border-line px-2.5 py-1 font-mono text-[12px] text-muted hover:border-line-strong"
                >
                  edit
                </button>
              )}
            </div>

            <div className="text-[13px] text-muted">{m.remit}</div>

            {/* How they talk, in their own words. The persona is the field you
                edit when one of them says something annoying, so it is the one
                worth seeing without opening a form. */}
            {m.persona.trim() && (
              <div className="border-l border-line pl-2.5 text-[12.5px] leading-relaxed text-faint italic">
                {m.persona.split("\n").join(" ")}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-1.5">
              <Voice member={m} voices={voices} />
              <span className="font-mono text-[11px] text-faint">
                {m.model} · {m.effort}
              </span>
            </div>

            {!m.chair && (
              <div className="flex flex-wrap gap-1">
                {m.tools.length ? (
                  m.tools.map((t) => (
                    <span
                      key={t}
                      className="rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-faint"
                    >
                      {t}
                    </span>
                  ))
                ) : (
                  <span className="font-mono text-[11px] text-faint">
                    no tools: answers from memory alone
                  </span>
                )}
                {m.web && (
                  <span className="rounded-full border border-line px-2 py-0.5 font-mono text-[10.5px] text-faint">
                    the web
                  </span>
                )}
              </div>
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
            {voices.length > 0 && (
              <select
                className={field}
                value={editing.voice}
                onChange={(e) => setEditing({ ...editing, voice: e.target.value })}
                aria-label="voice"
              >
                <option value="">the default voice</option>
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
            )}
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
