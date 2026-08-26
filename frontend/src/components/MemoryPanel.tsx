import { useState } from "react";
import type { CouncilMember, Memory, MemoryList, MemoryType, Schedule } from "../../../shared/api";
import { api, usePoll } from "../api";
import { focusIfPointerFine } from "./Sheet";

const TYPES: MemoryType[] = ["preference", "project", "reference"];

/**
 * The nightly harvest, as a schedule like any other.
 *
 * It is set up from here rather than being built into the backend because it is
 * nothing but an assistant schedule with a careful prompt: it shows up on the
 * schedules list, its runs land in the inbox, and it can be paused, retimed or
 * rewritten there like everything else. Matched by name, so pressing this twice
 * cannot leave two.
 */
const HARVEST_NAME = "memory harvest";
const HARVEST_PROMPT = [
  "Read what I typed into the sessions that ended in the last day with recent_prompts,",
  "and propose anything worth remembering with propose_memory.",
  "",
  "Worth remembering means it would change how a future agent acts: a preference, a",
  "correction I made, or how something in one of my repos actually works. Not the",
  "details of one task, not anything already in your memory. Write each one as an",
  "instruction to a future agent and say in source which session it came from.",
  "",
  "Most days there is nothing, and proposing nothing is the right answer. Reply with",
  'one line: "ok: nothing worth keeping" or "ok: proposed 2".',
].join("\n");

/** Slugs name files on the volume, so the server's rule is enforced here too. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Add or correct a fact by hand. The assistant writes most of these, but a
 * memory you cannot edit yourself is one you have to argue with a chatbot to
 * fix — and correcting a wrong one is exactly when you least want a
 * conversation.
 */
function Editor({
  memory,
  onDone,
  onCancel,
}: {
  memory?: Memory;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(memory?.text ?? "");
  const [type, setType] = useState<MemoryType>(memory?.type ?? "preference");
  const [scope, setScope] = useState(memory?.scope ?? "global");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const value = text.trim();
    // Editing keeps the slug: it is the filename, and renaming would leave the
    // old fact in place alongside the correction.
    const slug = memory?.slug ?? slugify(value);
    if (!value || !slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/memory/${slug}`, {
        method: "PUT",
        body: JSON.stringify({
          text: value,
          type,
          scope: scope.trim() || "global",
          source: "added by hand",
        }),
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[11px] border border-accent/40 bg-surface px-[15px] py-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        // Not autoFocus: on a phone that throws the keyboard up over the list
        // you were reading before you have decided to type.
        ref={focusIfPointerFine}
        placeholder="Something a future agent should know without being told again."
        className="w-full resize-y rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 text-[13.5px] outline-none placeholder:text-faint focus:border-accent"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={type}
          onChange={(e) => setType(e.target.value as MemoryType)}
          aria-label="type"
          className="rounded-[7px] border border-line bg-surface-2 px-2 py-1.5 font-mono text-[12px]"
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          aria-label="scope"
          placeholder="global, or a project"
          className="w-[170px] rounded-[7px] border border-line bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] outline-none placeholder:text-faint focus:border-accent"
        />
        <button
          onClick={() => void save()}
          disabled={busy || !text.trim()}
          className="tap ml-auto rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          {memory ? "save" : "remember"}
        </button>
        <button
          onClick={onCancel}
          className="tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text"
        >
          cancel
        </button>
      </div>
      {error && <div className="font-mono text-[11px] text-fail">{error}</div>}
    </div>
  );
}

/**
 * Everything verksted believes about how you work, and a way to delete any of
 * it. The assistant writes these; this is the only place you can see what it
 * decided to keep, which is what makes the whole thing answerable rather than
 * spooky.
 */
function Row({
  memory,
  onForget,
  onEdit,
}: {
  memory: Memory;
  onForget: () => void;
  onEdit: () => void;
}) {
  return (
    <div className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
      <div className="flex items-start gap-2.5">
        <p className="min-w-0 flex-1 text-[13.5px] break-words">{memory.text}</p>
        <button
          onClick={onEdit}
          aria-label={`edit: ${memory.text.slice(0, 40)}`}
          className="tap-sq flex-none rounded-[7px] border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
        >
          edit
        </button>
        <button
          onClick={onForget}
          aria-label={`forget: ${memory.text.slice(0, 40)}`}
          className="tap-sq flex-none rounded-[7px] border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-fail hover:text-fail"
        >
          forget
        </button>
      </div>
      <div className="mt-1.5 font-mono text-[11px] text-faint">
        {memory.type}
        {memory.scope !== "global" && ` · ${memory.scope}`}
        {memory.source && ` · ${memory.source}`}
      </div>
    </div>
  );
}

/**
 * What each advisor has written down for itself.
 *
 * Kept apart from the block above because it is a different promise: nothing
 * here is carried into a session, or into any other advisor's prompt. It is
 * listed at all for the reason the shared store is editable by hand — a note
 * you can only change by arguing with the thing that wrote it is one you will
 * not change.
 */
function MemberNotes({ member }: { member: CouncilMember }) {
  const { data, refresh } = usePoll<{ memories: Memory[] }>(
    `/api/council/${member.id}/memory`,
    120_000,
  );
  const notes = data?.memories ?? [];
  if (!notes.length) return null;

  async function forget(slug: string) {
    await api(`/api/council/${member.id}/memory/${slug}`, { method: "DELETE" }).catch(() => {});
    refresh();
  }

  return (
    <div className="rounded-[11px] border border-line bg-surface px-[15px] py-3">
      <div className="mb-2 font-mono text-[12px]">
        {member.name}
        <span className="ml-2 text-[11px] text-faint">
          {notes.length} note{notes.length === 1 ? "" : "s"}, read by nobody else
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {notes.map((m) => (
          <div key={m.slug} className="flex items-start gap-2 text-[13px]">
            <span className="min-w-0 flex-1 break-words text-muted">{m.text}</span>
            <button
              onClick={() => void forget(m.slug)}
              className="tap flex-none rounded-[7px] border border-line px-2 py-0.5 font-mono text-[11px] text-faint hover:border-wait hover:text-wait"
            >
              forget
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MemoryPanel() {
  const { data, refresh } = usePoll<MemoryList>("/api/memory", 30_000);
  const { data: schedules, refresh: refreshSchedules } = usePoll<Schedule[]>(
    "/api/schedules",
    60_000,
  );
  const { data: council } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const advisors = (council ?? []).filter((m) => !m.chair);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function forget(slug: string) {
    await api(`/api/memory/${slug}`, { method: "DELETE" }).catch(() => {});
    refresh();
  }

  const pct = data ? Math.min(100, Math.round((data.used / data.budget) * 100)) : 0;
  const harvest = (schedules ?? []).find((s) => s.kind === "assistant" && s.name === HARVEST_NAME);

  async function startHarvesting() {
    if (busy) return;
    setBusy(true);
    try {
      await api("/api/schedules", {
        method: "POST",
        body: JSON.stringify({
          name: HARVEST_NAME,
          kind: "assistant",
          cron: "0 3 * * *",
          // A day when no session ended has nothing to harvest, so it does not
          // run at all rather than paying a model call to find that out.
          skipWhenIdle: true,
          prompt: HARVEST_PROMPT,
        }),
      });
      refreshSchedules();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-8">
      <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
        Memory
      </div>
      <h2 className="mb-1 text-[21px] font-semibold tracking-tight">
        {data ? `${data.memories.length} fact${data.memories.length === 1 ? "" : "s"}` : "…"}
      </h2>
      <div className="mb-3 flex items-start justify-between gap-4">
        <div className="text-sm text-muted">
          Carried into every session, in every repo. The assistant writes most of these; add,
          correct or forget them here.
        </div>
        <button
          onClick={() => {
            setEditing(null);
            setAdding(true);
          }}
          className="tap flex-none rounded-lg bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110"
        >
          + remember
        </button>
      </div>

      {data && data.memories.length > 0 && (
        <>
          <div className="mb-1 h-[5px] overflow-hidden rounded-full bg-surface-2">
            <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
          </div>
          <div className="mb-4 font-mono text-[11px] text-faint">
            {data.used} of {data.budget} bytes
            {data.dropped > 0 && ` · ${data.dropped} too old to be included`}
          </div>
        </>
      )}

      {/* Learning without being asked, and what it costs, stated plainly: the
          harvest reads only what you typed, so a night of it is a few
          kilobytes rather than a transcript. */}
      <div className="mb-4 flex flex-wrap items-center gap-2.5 rounded-[11px] border border-dashed border-line px-[15px] py-2.5">
        <div className="flex-1 text-[13px] text-muted">
          {harvest
            ? harvest.enabled
              ? "Learning nightly from what you typed into finished sessions. Anything it notices waits in the inbox until you keep it."
              : "Nightly learning is paused. Resume it on the schedules list below."
            : "It only learns what you tell it directly. Turn on the nightly pass and it will read back what you typed into finished sessions and propose what it noticed — nothing is remembered until you keep it in the inbox."}
        </div>
        {harvest ? (
          <span className="font-mono text-[11px] text-faint">{harvest.cron}</span>
        ) : (
          <button
            onClick={startHarvesting}
            disabled={busy}
            className="tap flex-none rounded-lg border border-line px-3 py-1.5 font-mono text-[12px] text-muted hover:border-accent hover:text-accent disabled:opacity-50"
          >
            learn nightly
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {adding && (
          <Editor
            onDone={() => {
              setAdding(false);
              refresh();
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {data?.memories.length === 0 && !adding && (
          <div className="text-[13.5px] text-faint">
            Nothing learned yet. It fills up as you correct the assistant or tell it how things
            work.
          </div>
        )}
        {data?.memories.map((m) =>
          editing === m.slug ? (
            <Editor
              key={m.slug}
              memory={m}
              onDone={() => {
                setEditing(null);
                refresh();
              }}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Row
              key={m.slug}
              memory={m}
              onEdit={() => setEditing(m.slug)}
              onForget={() => void forget(m.slug)}
            />
          ),
        )}
      </div>

      {advisors.length > 0 && (
        <>
          <h3 className="mt-6 mb-1 text-[15px] font-semibold tracking-tight">
            What each advisor keeps
          </h3>
          <div className="mb-3 text-sm text-muted">
            Their own notes, on their own subject. None of this reaches a session or another
            advisor, so it is off the budget above.
          </div>
          <div className="flex flex-col gap-2">
            {advisors.map((m) => (
              <MemberNotes key={m.id} member={m} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}
