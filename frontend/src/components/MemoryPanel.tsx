import { useState } from "react";
import type { Memory, MemoryList, MemoryType } from "../../../shared/api";
import { api, usePoll } from "../api";
import { focusIfPointerFine } from "./Sheet";

const TYPES: MemoryType[] = ["preference", "project", "reference"];

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
          className="ml-auto rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
        >
          {memory ? "save" : "remember"}
        </button>
        <button
          onClick={onCancel}
          className="rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text"
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

export default function MemoryPanel() {
  const { data, refresh } = usePoll<MemoryList>("/api/memory", 30_000);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  async function forget(slug: string) {
    await api(`/api/memory/${slug}`, { method: "DELETE" }).catch(() => {});
    refresh();
  }

  const pct = data ? Math.min(100, Math.round((data.used / data.budget) * 100)) : 0;

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
          className="flex-none rounded-lg bg-accent px-3 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110"
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
    </section>
  );
}
