import { useEffect, useState } from "react";
import type { AssistantThread, AssistantThreadSummary } from "../../../../shared/api";
import { agoLabel, api } from "../../api";
import { useConfirm } from "../../useConfirm";
import Icon from "../Icon";
import Sheet from "../Sheet";
import Skeleton from "../Skeleton";
import { Input } from "../ui/Field";

/**
 * Every conversation this room has had: switch to one, start one, delete one,
 * or clear out the old ones.
 *
 * Fetched when opened and again after each change rather than polled: the
 * list only changes by something done on this sheet. Deleting asks first,
 * since a thread cannot be brought back; deleting the open one starts a fresh
 * thread in its place, which the socket brings to the screen.
 */
export default function Threads({
  current,
  onOpen,
  onNew,
  onClose,
}: {
  current: string | undefined;
  onOpen: (thread: AssistantThread) => void;
  onNew: () => void;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<AssistantThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [confirm, dialog] = useConfirm();
  const [query, setQuery] = useState("");
  /** The thread being renamed, and the name typed so far. */
  const [naming, setNaming] = useState<{ id: string; title: string } | null>(null);
  // A search asks the server, which reads what was said in every thread
  // (C-30). A quarter second after the last key, so typing a word is one
  // request rather than one per letter.
  useEffect(() => {
    let live = true;
    const q = query.trim();
    const timer = setTimeout(
      () => {
        api<AssistantThreadSummary[]>(
          `/api/assistant/threads${q ? `?q=${encodeURIComponent(q)}` : ""}`,
        )
          .then((t) => live && setThreads(t))
          .catch((e: Error) => live && setError(e.message));
      },
      q ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [version, query]);

  async function rename() {
    if (!naming) return;
    setError(null);
    try {
      await api(`/api/assistant/threads/${naming.id}/title`, {
        method: "PUT",
        body: JSON.stringify({ title: naming.title }),
      });
      setNaming(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const others = (threads ?? []).filter((t) => t.conversationId !== current);

  async function open(id: string) {
    try {
      onOpen(
        await api<AssistantThread>(`/api/assistant/threads/${id}/open`, {
          method: "POST",
        }),
      );
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove(t: AssistantThreadSummary) {
    const here = t.conversationId === current;
    const ok = await confirm({
      title: "Delete this thread?",
      body: `"${t.title}" and everything said in it.${
        here ? " It is the one open now, so a new thread starts." : ""
      } This cannot be undone.`,
      action: "delete",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api(`/api/assistant/threads/${t.conversationId}`, { method: "DELETE" });
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function clearOld() {
    const n = others.length;
    const ok = await confirm({
      title: `Delete ${n} old thread${n === 1 ? "" : "s"}?`,
      body: "Every thread except the one open now, and everything said in them. This cannot be undone.",
      action: `delete ${n}`,
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api("/api/assistant/threads/clear", { method: "POST", body: JSON.stringify({}) });
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <Sheet
        title="Threads"
        sub="Switch, start fresh, or clear out the old ones."
        onClose={onClose}
      >
        <button
          type="button"
          onClick={() => {
            onNew();
            onClose();
          }}
          className="tap mb-3 flex w-full items-center justify-center gap-2 rounded-xl bg-accent px-3 py-2 text-[13.5px] font-semibold text-on-accent hover:brightness-110"
        >
          <Icon name="compose" size={15} />
          new thread
        </button>
        <Input
          type="search"
          label="search the threads"
          placeholder="search what was said"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-3 w-full"
        />
        {error && (
          <div role="alert" className="mb-2 text-[12.5px] text-fail">
            {error}
          </div>
        )}
        {threads === null && !error && (
          <div className="flex flex-col gap-1.5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="block h-[52px] rounded-xl bg-surface-2/60" />
            ))}
          </div>
        )}
        {threads?.length === 0 && (
          <div className="text-sm text-muted">
            {query.trim() ? "no thread said that" : "nothing said in here yet"}
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {threads?.map((t) => {
            const here = t.conversationId === current;
            return (
              <div
                key={t.conversationId}
                className={`flex items-center rounded-xl ${
                  here
                    ? "bg-accent-tint ring-1 ring-accent/30"
                    : "bg-surface-2/60 hover:bg-surface-2"
                }`}
              >
                {naming?.id === t.conversationId ? (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename();
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5"
                  >
                    <Input
                      label="the thread's name"
                      placeholder="empty goes back to its first line"
                      value={naming.title}
                      onChange={(e) => setNaming({ ...naming, title: e.target.value })}
                      className="min-w-0 flex-1"
                    />
                    <button
                      type="submit"
                      className="tap flex-none rounded-lg px-2 text-[12.5px] font-semibold text-accent"
                    >
                      save
                    </button>
                    <button
                      type="button"
                      onClick={() => setNaming(null)}
                      className="tap flex-none rounded-lg px-1.5 text-[12.5px] text-muted"
                    >
                      cancel
                    </button>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => void open(t.conversationId)}
                    disabled={here}
                    title={here ? "the thread open now" : "open this thread"}
                    className="tap flex min-w-0 flex-1 flex-col items-start gap-0.5 px-3 py-2 text-left disabled:cursor-default"
                  >
                    <span className="w-full truncate text-[13.5px]">{t.title}</span>
                    {t.match && (
                      <span className="line-clamp-2 w-full text-[12px] text-muted">{t.match}</span>
                    )}
                    <span className="font-mono text-[11px] text-faint">
                      {here ? "open now" : agoLabel(t.at)} · {t.turns} turn
                      {t.turns === 1 ? "" : "s"}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setNaming({ id: t.conversationId, title: t.renamed ? t.title : "" })
                  }
                  title="rename this thread"
                  aria-label={`rename the thread "${t.title}"`}
                  className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-lg text-faint hover:bg-surface-2 hover:text-text"
                >
                  <Icon name="rename" size={15} />
                </button>
                <a
                  href={`/api/assistant/threads/${t.conversationId}/export`}
                  download
                  title="download as markdown"
                  aria-label={`download the thread "${t.title}" as markdown`}
                  className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-lg text-faint hover:bg-surface-2 hover:text-text"
                >
                  <Icon name="download" size={15} />
                </a>
                <button
                  type="button"
                  onClick={() => void remove(t)}
                  title="delete this thread"
                  aria-label={`delete the thread "${t.title}"`}
                  className="tap-sq mr-1 flex h-9 w-9 flex-none items-center justify-center rounded-lg text-faint hover:bg-fail/10 hover:text-fail"
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            );
          })}
        </div>
        {/* Not while searching: it clears every old thread, not the ones found. */}
        {others.length > 0 && !query.trim() && (
          <button
            type="button"
            onClick={() => void clearOld()}
            className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-line px-3 py-2 text-[13px] text-muted hover:border-fail/50 hover:text-fail"
          >
            <Icon name="trash" size={14} />
            clear old threads ({others.length})
          </button>
        )}
      </Sheet>
      {dialog}
    </>
  );
}
