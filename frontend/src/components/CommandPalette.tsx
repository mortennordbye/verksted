import { Command } from "cmdk";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { Project, Session } from "../../../shared/api";
import { usePoll } from "../api";
import Skeleton from "./Skeleton";
import Overlay from "./ui/Overlay";

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
        to: `/p/${encodeURIComponent(p.name)}`,
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

  // Filtered here rather than by cmdk: its scorer ranks by its own idea of a
  // match, and this palette's subsequence test is what ids like these want.
  const shown = useMemo(
    () => (entries ?? []).filter((e) => matches(e, query)).slice(0, 40),
    [entries, query],
  );

  function go(entry: Entry) {
    onClose();
    void navigate(entry.to);
  }

  // cmdk carries the keyboard: the arrows, Enter, the highlighted row kept in
  // view, and the combobox and listbox roles a screen reader needs to hear
  // which row that is. This palette had hand-rolled the first three.
  return (
    <Overlay
      label="Jump to"
      onClose={onClose}
      placement="top"
      className="max-h-[70dvh] w-full max-w-[560px] overflow-hidden rounded-2xl"
    >
      <Command shouldFilter={false} loop label="Jump to" className="flex min-h-0 flex-col">
        <Command.Input
          // The palette is opened in order to type into it, so moving focus
          // here is the action the user just asked for rather than a surprise.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="jump to a project or session…"
          aria-label="jump to a project or session"
          className="flex-none border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-faint"
        />
        <Command.List className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.map((entry) => (
            <Command.Item
              key={entry.id}
              value={entry.id}
              onSelect={() => go(entry)}
              className="flex w-full cursor-pointer items-baseline gap-3 px-4 py-2 text-left data-[selected=true]:bg-surface-2"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.label}</span>
              <span className="flex-none font-mono text-[11px] text-faint">{entry.hint}</span>
            </Command.Item>
          ))}
          {entries !== null && shown.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-faint">nothing matches</div>
          )}
          {entries === null && (
            <Command.Loading label="loading">
              {["w-2/5", "w-3/5", "w-1/2"].map((w) => (
                <div key={w} className="px-4 py-2.5">
                  <Skeleton className={`block h-3.5 rounded bg-surface-2 ${w}`} />
                </div>
              ))}
            </Command.Loading>
          )}
        </Command.List>
      </Command>
    </Overlay>
  );
}
