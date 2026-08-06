import type { Memory, MemoryList } from "../../../shared/api";
import { api, usePoll } from "../api";

/**
 * Everything verksted believes about how you work, and a way to delete any of
 * it. The assistant writes these; this is the only place you can see what it
 * decided to keep, which is what makes the whole thing answerable rather than
 * spooky.
 */
function Row({ memory, onForget }: { memory: Memory; onForget: () => void }) {
  return (
    <div className="rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
      <div className="flex items-start gap-2.5">
        <p className="min-w-0 flex-1 text-[13.5px] break-words">{memory.text}</p>
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
      <div className="mb-3 text-sm text-muted">
        Carried into every session, in every repo. Tell the assistant to remember something, or
        forget it here.
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
        {data?.memories.length === 0 && (
          <div className="text-[13.5px] text-faint">
            Nothing learned yet. It fills up as you correct the assistant or tell it how things
            work.
          </div>
        )}
        {data?.memories.map((m) => (
          <Row key={m.slug} memory={m} onForget={() => void forget(m.slug)} />
        ))}
      </div>
    </section>
  );
}
