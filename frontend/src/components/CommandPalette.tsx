import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type { Project, Session } from "../../../shared/api";
import { usePoll } from "../api";
import Skeleton from "./Skeleton";
import { useDismissOnBack } from "../useDismissOnBack";

interface Entry {
  id: string;
  label: string;
  hint: string;
  to: string;
}

/**
 * Cmd/Ctrl+K: jump to any project or session by typing.
 *
 * The app had no keyboard route to anything — every navigation was a click,
 * and with several projects open the hub round-trip is the slow part of using
 * this on a desktop. Data is fetched when the palette opens rather than polled,
 * since it is only ever on screen for a second or two.
 *
 * Matching is a subsequence test, so "vkd3" finds "vk-demo-3" — the way every
 * other palette behaves, and much better than substring for ids like these.
 */
function matches(entry: Entry, query: string): boolean {
  if (!query) return true;
  const haystack = `${entry.label} ${entry.hint}`.toLowerCase();
  let i = 0;
  for (const ch of query.toLowerCase()) {
    i = haystack.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useDismissOnBack(true, onClose);

  /**
   * Both lists come from the two paths the event stream already holds, so an
   * open normally costs no request at all and paints from what the hub was
   * showing a moment ago. It used to fetch the projects and then one session
   * list per project — on a bench with eight repos, nine requests every time
   * the palette was opened, for a list the app already had.
   */
  const { data: projects } = usePoll<Project[]>("/api/projects", 30_000);
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 30_000);

  const entries = useMemo<Entry[] | null>(() => {
    if (!projects && !sessions) return null;
    return [
      ...(projects ?? []).map((p) => ({
        id: `p:${p.name}`,
        label: `~/${p.name}`,
        hint: `project · ${p.branch}${p.waiting ? ` · ${p.waiting} waiting` : ""}`,
        to: `/p/${p.name}`,
      })),
      ...(sessions ?? [])
        .filter((s) => s.status !== "done")
        .map((s) => ({
          id: `s:${s.id}`,
          label: s.title,
          hint: `${s.status} · ${s.agent} · ${s.project}`,
          to: `/s/${s.id}`,
        })),
    ];
  }, [projects, sessions]);

  const shown = useMemo(
    () => (entries ?? []).filter((e) => matches(e, query)).slice(0, 40),
    [entries, query],
  );

  // Keep the highlight on a row that still exists as the query narrows.
  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function go(entry: Entry | undefined) {
    if (!entry) return;
    onClose();
    void navigate(entry.to);
  }

  return (
    <div
      // Presentational: clicking away duplicates Escape and Android Back.
      role="presentation"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        className="flex max-h-[70dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-surface"
      >
        <input
          // The palette is opened in order to type into it, so moving focus here is
          // the action the user just asked for rather than a surprise. Without it
          // every open would need a Tab first.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              go(shown[active]);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder="jump to a project or session…"
          aria-label="jump to a project or session"
          className="flex-none border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-faint"
        />
        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((entry, i) => (
            <li key={entry.id}>
              <button
                onMouseEnter={() => setActive(i)}
                onClick={() => go(entry)}
                className={`flex w-full items-baseline gap-3 px-4 py-2 text-left ${
                  i === active ? "bg-surface-2" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.label}</span>
                <span className="flex-none font-mono text-[11px] text-faint">{entry.hint}</span>
              </button>
            </li>
          ))}
          {entries !== null && shown.length === 0 && (
            <li className="px-4 py-3 text-[13px] text-faint">nothing matches</li>
          )}
          {entries === null &&
            ["w-2/5", "w-3/5", "w-1/2"].map((w) => (
              <li key={w} className="px-4 py-2.5">
                <Skeleton className={`block h-3.5 rounded bg-surface-2 ${w}`} />
              </li>
            ))}
        </ul>
      </div>
    </div>
  );
}
