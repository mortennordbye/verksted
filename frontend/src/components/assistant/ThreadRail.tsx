import { useEffect, useState } from "react";
import type { AssistantThread, AssistantThreadSummary } from "../../../../shared/api";
import { api } from "../../api";
import Icon from "../Icon";

const DAY_MS = 86_400_000;

/** A thread's place in the list, by how long ago it last moved. */
export function ageGroup(at: string, now = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const when = Date.parse(at);
  if (when >= midnight) return "today";
  if (when >= midnight - DAY_MS) return "yesterday";
  if (when >= midnight - 6 * DAY_MS) return "this week";
  return "earlier";
}

/**
 * The threads beside the conversation, on a screen with room for them.
 *
 * Only where it clears the 800px column, so it never moves the conversation, and a
 * phone keeps the sheet. Renaming, downloading and deleting stay on the sheet too:
 * this is for moving between threads, which is what you do most.
 */
export default function ThreadRail({
  current,
  turns,
  locked,
  onOpen,
  onNew,
}: {
  current: string | undefined;
  /** How far the open thread has got, so its place in the list stays right. */
  turns: number;
  /** A turn is running, and a thread cannot be switched under it. */
  locked: boolean;
  onOpen: (thread: AssistantThread) => void;
  onNew: () => void;
}) {
  const [threads, setThreads] = useState<AssistantThreadSummary[]>([]);

  useEffect(() => {
    let live = true;
    api<AssistantThreadSummary[]>("/api/assistant/threads")
      .then((t) => live && setThreads(t))
      // The sheet says what went wrong. An empty rail is not worth a second notice.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [current, turns]);

  async function open(id: string) {
    onOpen(await api<AssistantThread>(`/api/assistant/threads/${id}/open`, { method: "POST" }));
  }

  const groups = new Map<string, AssistantThreadSummary[]>();
  for (const t of threads) {
    const group = ageGroup(t.at);
    groups.set(group, [...(groups.get(group) ?? []), t]);
  }

  return (
    <nav
      aria-label="threads"
      className="fixed inset-y-0 left-0 z-10 hidden w-[260px] flex-col gap-3 overflow-y-auto border-r border-line bg-bg px-3 pt-[108px] pb-4 min-[1360px]:flex"
    >
      <button
        type="button"
        onClick={onNew}
        disabled={locked}
        className="tap flex flex-none items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] text-muted transition-colors hover:border-accent hover:text-text disabled:opacity-50"
      >
        <Icon name="compose" size={14} />
        new thread
      </button>
      {[...groups].map(([group, list]) => (
        <div key={group} className="flex flex-col gap-0.5">
          <div className="caps px-2 pb-1 text-meta text-faint">{group}</div>
          {list.map((t) => {
            const here = t.conversationId === current;
            return (
              <button
                key={t.conversationId}
                type="button"
                onClick={() => void open(t.conversationId)}
                disabled={here || locked}
                aria-current={here ? "true" : undefined}
                className={`truncate rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors ${
                  here
                    ? "bg-surface-2 text-text"
                    : "text-muted hover:bg-surface hover:text-text disabled:hover:bg-transparent"
                }`}
              >
                {t.title}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
