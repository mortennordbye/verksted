import { Command } from "cmdk";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import type { DocHit, FeedItem, Project, Session } from "../../../shared/api";
import { api, usePoll } from "../api";
import PollError from "./PollError";
import { openShortcuts } from "../palette";
import Skeleton from "./Skeleton";
import Overlay from "./ui/Overlay";

interface Entry {
  id: string;
  label: string;
  hint: string;
  /** Where it goes; or, for an entry that does something here, what it does. */
  to?: string;
  run?: () => void;
}

/** How many of each kind to draw: enough to choose from, few enough to read. */
const PER_GROUP = 12;

/**
 * Whether an entry answers what was typed.
 *
 * Every word typed has to be somewhere in the label or the hint, which is how
 * a mail subject or a document is found. Failing that, the query as a
 * subsequence of the label, so "vkd3" still finds "vk-demo-3" the way every
 * other palette finds an id. Subsequence alone over a sentence matches nearly
 * anything, which is why it is kept to the label.
 */
function matches(entry: Entry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = `${entry.label} ${entry.hint}`.toLowerCase();
  if (q.split(/\s+/).every((w) => haystack.includes(w))) return true;
  const label = entry.label.toLowerCase();
  let i = 0;
  for (const ch of q.replace(/\s+/g, "")) {
    i = label.indexOf(ch, i);
    if (i === -1) return false;
    i++;
  }
  return true;
}

/**
 * Cmd/Ctrl+K, or the top bar's search button: find anything by typing.
 *
 * It jumped to a project or a live session and knew nothing else, while the
 * app had three other places a thing could be: a session that had finished,
 * the inbox, and the documents on the share (F-49). All four are here now. The
 * lists come from the paths the event stream and the tab bar already hold, so
 * opening costs nothing; the documents are a full-text search on the pod, so
 * they are asked for only once two characters are typed, and a beat after the
 * typing stops.
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");

  const projectsPoll = usePoll<Project[]>("/api/projects", 30_000);
  const sessionsPoll = usePoll<Session[]>("/api/sessions", 30_000);
  const feedPoll = usePoll<FeedItem[]>("/api/feed", 120_000);
  const { data: projects } = projectsPoll;
  const { data: sessions } = sessionsPoll;
  const { data: feed } = feedPoll;
  // A failed read is said, or "nothing matches" would stand in for it.
  const failed = (
    [
      [projectsPoll, "the projects"],
      [sessionsPoll, "the sessions"],
      [feedPoll, "the inbox"],
    ] as const
  ).filter(([poll]) => poll.error);

  // Held with the query it answers, so a stale answer is never drawn under a
  // query it was not for, and nothing has to be cleared when the query changes.
  const [docs, setDocs] = useState<{ q: string; hits: DocHit[] } | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    let live = true;
    const timer = setTimeout(() => {
      api<DocHit[]>(`/api/docs/search?q=${encodeURIComponent(q)}`)
        .then((hits) => live && setDocs({ q, hits }))
        // No share mounted, or the search failed: there are simply no documents.
        .catch(() => live && setDocs({ q, hits: [] }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q]);

  const groups = useMemo(() => {
    const pick = (list: Entry[]) => list.filter((e) => matches(e, query)).slice(0, PER_GROUP);
    const live = (s: Session) => s.status !== "done";
    return [
      {
        heading: "Projects",
        entries: pick(
          (projects ?? []).map((p) => ({
            id: `p:${p.name}`,
            label: `~/${p.name}`,
            hint: `project · ${p.branch}${p.waiting ? ` · ${p.waiting} waiting` : ""}`,
            to: `/p/${encodeURIComponent(p.name)}`,
          })),
        ),
      },
      {
        heading: "Sessions",
        // Live ones first; the finished ones are there to be found, not browsed.
        entries: pick(
          [...(sessions ?? [])]
            .sort((a, b) => Number(live(b)) - Number(live(a)))
            .map((s) => ({
              id: `s:${s.id}`,
              label: s.title,
              hint: `${s.status} · ${s.agent} · ${s.project}`,
              to: `/s/${s.id}`,
            })),
        ),
      },
      {
        heading: "Inbox",
        entries: pick(
          (feed ?? [])
            .filter((f) => f.state !== "done")
            .map((f) => ({
              id: `f:${f.id}`,
              label: f.title,
              hint: `${f.source}${f.from ? ` · ${f.from}` : ""}`,
              to: `/runs#${encodeURIComponent(f.id)}`,
            })),
        ),
      },
      {
        heading: "Documents",
        entries:
          docs && docs.q === q
            ? docs.hits.slice(0, PER_GROUP).map((h) => ({
                id: `d:${h.path}`,
                label: h.path.split("/").at(-1) ?? h.path,
                hint: h.excerpt,
                to: `/docs?doc=${encodeURIComponent(h.path)}`,
              }))
            : [],
      },
      {
        heading: "Help",
        entries: pick([
          {
            id: "h:shortcuts",
            label: "Keyboard shortcuts",
            hint: "every key the app answers to",
            run: openShortcuts,
          },
        ]),
      },
    ].filter((g) => g.entries.length > 0);
  }, [projects, sessions, feed, docs, q, query]);

  const loading = !projects && !sessions;
  const searchingDocs = q.length >= 2 && docs?.q !== q;

  function go(entry: Entry) {
    onClose();
    if (entry.run) entry.run();
    else if (entry.to) void navigate(entry.to);
  }

  // cmdk carries the keyboard: the arrows, Enter, the highlighted row kept in
  // view, and the combobox and listbox roles a screen reader needs to hear
  // which row that is.
  return (
    <Overlay
      label="Search"
      onClose={onClose}
      placement="top"
      className="max-h-[70dvh] w-full max-w-[560px] overflow-hidden rounded-2xl"
    >
      <Command shouldFilter={false} loop label="Search" className="flex min-h-0 flex-col">
        <Command.Input
          // The palette is opened in order to type into it, so moving focus
          // here is the action the user just asked for rather than a surprise.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          onValueChange={setQuery}
          placeholder="projects, sessions, the inbox, documents…"
          aria-label="search"
          className="flex-none border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-faint"
        />
        <Command.List className="min-h-0 flex-1 overflow-y-auto py-1">
          {failed.length > 0 && (
            <div className="px-4 pt-2">
              {failed.map(([poll, what]) => (
                <PollError key={what} error={poll.error} what={what} retry={poll.refresh} />
              ))}
            </div>
          )}
          {groups.map((g) => (
            <Command.Group
              key={g.heading}
              heading={g.heading}
              className="[&_[cmdk-group-heading]]:caps [&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-2.5 [&_[cmdk-group-heading]]:pb-1"
            >
              {g.entries.map((entry) => (
                <Command.Item
                  key={entry.id}
                  value={entry.id}
                  onSelect={() => go(entry)}
                  className="flex w-full cursor-pointer items-baseline gap-3 px-4 py-2 text-left data-[selected=true]:bg-surface-2"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px]">{entry.label}</span>
                  <span className="max-w-[45%] flex-none truncate font-mono text-[11px] text-faint">
                    {entry.hint}
                  </span>
                </Command.Item>
              ))}
            </Command.Group>
          ))}
          {!loading && groups.length === 0 && !searchingDocs && failed.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-faint">nothing matches</div>
          )}
          {(loading || searchingDocs) && (
            <Command.Loading label="loading">
              {["w-2/5", "w-3/5"].map((w) => (
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
