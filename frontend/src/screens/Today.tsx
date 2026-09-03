import { useState } from "react";
import Markdown from "react-markdown";
import { Link } from "react-router";
import type {
  AssistantConfig,
  AssistantThread,
  CalendarEvent,
  FeedItem,
  Loop,
  Memory,
  Profile,
  ScheduleRun,
  Session,
  SourceStatus,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { cite } from "../components/chat/cite";
import { MD } from "../components/chat/markdown";
import ProposalCard from "../components/ProposalCard";
import Sheet from "../components/Sheet";
import { AgentMark, StatusChip } from "../components/StatusChip";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import { useGrow } from "../useGrow";
import { canSpeak, unlockAudio, useSpeech } from "../useSpeech";

/**
 * The home screen: what the assistant would tell you if you asked, before you
 * ask.
 *
 * A chat starts empty, and every morning the first thing on it was a cursor.
 * This is the page instead: what needs you, the morning's brief, what is
 * running, with the composer under it so following up on the brief does not
 * mean leaving it. The bench and the thread are a tab away.
 *
 * Everything here is read from lists the app already keeps; nothing is
 * computed for this screen. The brief is the newest reply of an assistant
 * schedule, which is what a briefing is.
 */
function Label({ children }: { children: string }) {
  return (
    <div className="mb-2 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
      {children}
    </div>
  );
}

const OUTCOME: Record<string, "run" | "wait" | "fail" | "idle"> = {
  ok: "run",
  attention: "wait",
  failed: "fail",
  blocked: "idle",
  running: "run",
  done: "idle",
};

/** The date as a person says it, in the browser's own language. */
function dateLine(): string {
  return new Date().toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

/** 14:30, in the browser's own zone and convention. */
function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** How many of a schedule's firings in a row ended the way this one did. */
function streak(runs: ScheduleRun[], run: ScheduleRun): number {
  const own = runs.filter((r) => r.scheduleId === run.scheduleId);
  const ended = own.findIndex((r) => r.outcome !== run.outcome);
  return ended === -1 ? own.length : ended;
}

/**
 * A verdict as one line: the first sentence of what the run said.
 *
 * A report is paragraphs — the morning brief is four — and a row is one line,
 * so the whole of it truncated left the sentence that matters off the end. The
 * verdict word goes with it: the chip beside it already says "needs you".
 */
function oneLine(said: string): string {
  const first = said
    .trim()
    .split(/\n\s*\n/)[0]
    .replace(/\s*\n\s*/g, " ")
    .replace(/^(attention|failed|ok|blocked)\b\s*:?\s*/i, "");
  const end = first.search(/[.!?](\s|$)/);
  return end === -1 ? first : first.slice(0, end + 1);
}

/**
 * Which one a loop is about, in as few characters as say it.
 *
 * Triage writes the words ("review the PR") and files the item id beside them,
 * and six rows reading "review PR" were six different PRs. The id is what
 * tells them apart, so the row carries the repo and number the item links to,
 * or the source's own name when the link is not a PR.
 */
function sourceLabel(loop: Loop, items: Map<string, FeedItem>): string | null {
  const item = loop.from ? items.get(loop.from) : undefined;
  if (!item) return null;
  const pr = /github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(item.link ?? "");
  if (pr) return `${pr[1]}#${pr[2]}`;
  return item.title.split(":")[0].split("/").pop() || null;
}

/**
 * A row that needs you, and where it goes. `runs` is how many firings in a row
 * ended this way, shown from two: one bad night and four are the same row
 * otherwise, and the difference is the whole triage.
 */
function Need({
  to,
  chip,
  text,
  runs = 1,
  onDismiss,
}: {
  to: string;
  chip: "wait" | "fail";
  text: string;
  runs?: number;
  onDismiss?: () => void;
}) {
  return (
    <div className="flex items-center rounded-lg border border-wait/30 bg-wait/8 hover:border-wait/60">
      <Link to={to} className="tap flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
        <StatusChip kind={chip} label={chip === "wait" ? "needs you" : "failed"} />
        <span className="min-w-0 flex-1 truncate text-[13.5px]">{text}</span>
        {runs > 1 && (
          <span className="flex-none font-mono text-[11px] text-faint">{runs} runs</span>
        )}
        <span className="flex-none text-[13px] text-faint">→</span>
      </Link>
      {onDismiss && (
        <button
          onClick={onDismiss}
          title="nothing to do here; ask again if it changes"
          aria-label="dismiss"
          className="tap flex-none px-2.5 py-2 text-muted hover:text-wait"
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * Ask from here, and read the answer here.
 *
 * Posts to the same thread the chat screen shows, so nothing said on Today is
 * lost; the reply opens in a sheet with the way to the thread in its corner.
 * No voice, no images, no stop: those are the chat's, and this is the short
 * question you ask on the way out of the door.
 */
function Composer({ name }: { name: string }) {
  const [text, setText] = useState("");
  const grow = useGrow(text);
  const [asked, setAsked] = useState<string | null>(null);
  const [reply, setReply] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = asked !== null && reply === null && error === null;

  async function send() {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setAsked(value);
    setReply(null);
    setError(null);
    try {
      const thread = await api<AssistantThread>("/api/assistant/messages", {
        method: "POST",
        body: JSON.stringify({ text: value }),
        // A turn does real work; the default would abandon every one of them.
        timeoutMs: 11 * 60_000,
      });
      const last = [...thread.entries].reverse().find((e) => e.role === "assistant" && e.text);
      setReply(last?.text ?? "(no reply)");
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
        <div className="flex items-end gap-2">
          <textarea
            ref={grow}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={`ask ${name}…`}
            aria-label={`ask ${name}`}
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent text-[15px] outline-none placeholder:text-faint"
          />
          <button
            onClick={() => void send()}
            disabled={!text.trim() || busy}
            aria-label="send"
            className="tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface-2 disabled:text-faint"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5M5 12l7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
      {asked !== null && (
        <Sheet
          title={name}
          sub={asked}
          onClose={() => {
            if (!busy) setAsked(null);
          }}
        >
          {busy && (
            <div className="flex items-center gap-2 font-mono text-[12px] text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          {error && <div className="font-mono text-[12px] text-fail">{error}</div>}
          {reply && (
            <div className="text-[14px]">
              <Markdown components={MD}>{cite(reply)}</Markdown>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Link to="/ai" className="font-mono text-[12px] text-accent hover:underline">
              open the thread →
            </Link>
          </div>
        </Sheet>
      )}
    </>
  );
}

export default function Today() {
  // The one thing that can fail from this screen without a sheet to say so:
  // the × on a row. Kept next to the count, which is what it changes.
  const [error, setError] = useState<string | null>(null);
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 8_000);
  const { data: runs, refresh: refreshRuns } = usePoll<ScheduleRun[]>("/api/runs", 30_000);
  const { data: proposed } = usePoll<{ proposals: Memory[] }>("/api/memory/proposed", 120_000);
  const { data: config } = usePoll<AssistantConfig>("/api/assistant/config", 300_000);
  const { data: profile } = usePoll<Profile>("/api/profile", 300_000);
  const { data: loops, refresh: refreshLoops } = usePoll<Loop[]>("/api/loops", 60_000);
  const { data: feed, refresh: refreshFeed } = usePoll<FeedItem[]>("/api/feed", 30_000);
  const cards = (feed ?? []).filter((i) => i.source === "proposal" && i.state !== "done");
  const newest = (feed ?? [])
    .filter((i) => i.state !== "done" && i.source !== "proposal")
    .slice(0, 6);
  // Read the brief aloud, in the pod's voice where it has one. No microphone
  // here: that is the chat's; this is the morning read while the coffee pours.
  const speech = useSpeech(() => {});
  const { data: sources } = usePoll<SourceStatus>("/api/sources", 300_000);
  const { data: events } = usePoll<CalendarEvent[]>(
    sources?.calendar ? "/api/calendar/today" : null,
    300_000,
  );
  const open = (loops ?? []).filter((l) => l.state === "open");
  const name = config?.name?.trim() || "the assistant";
  // What a loop came from, so a row can say which PR it means. The feed is on
  // this screen already; a loop whose item has aged out simply says nothing.
  const items = new Map((feed ?? []).map((i) => [i.id, i] as const));
  const ghDown = (feed ?? []).some((i) => i.id === "github:poller" && i.state !== "done");

  async function dismiss(r: ScheduleRun) {
    try {
      await api(`/api/schedules/${r.scheduleId}/dismiss`, {
        method: "POST",
        body: JSON.stringify({ at: r.at }),
      });
      refreshRuns();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function closeLoop(slug: string) {
    try {
      await api(`/api/loops/${slug}/close`, { method: "POST" });
      refreshLoops();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const waiting = (sessions ?? []).filter((s) => s.status === "waiting");
  const running = (sessions ?? []).filter((s) => s.status === "running");
  // One row per schedule, and only while the flagged run is its newest: three
  // nights of the same failure are one problem, and a schedule that has since
  // gone green is none. Runs arrive newest first, so the first of each is it.
  const newestRun = new Map<string, ScheduleRun>();
  for (const r of runs ?? []) if (!newestRun.has(r.scheduleId)) newestRun.set(r.scheduleId, r);
  const proposals = proposed?.proposals.length ?? 0;
  // The brief is the newest thing an assistant schedule said. A run that
  // started a session is not one: its report is a repo's, not the morning's.
  const brief = (runs ?? []).find((r) => r.kind === "assistant" && r.report);
  // Never the brief: it is on this page in full, a screen further down, and a
  // row that truncates the same words is not a second thing to do. Never a
  // verdict already waved off, until the schedule says something else.
  const flagged = [...newestRun.values()].filter(
    (r) => (r.outcome === "attention" || r.outcome === "failed") && r !== brief && !r.dismissed,
  );
  const loaded = sessions !== null && runs !== null;
  const needs = waiting.length + flagged.length + (proposals ? 1 : 0);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar crumb={[{ label: "today" }]} />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-[18px] pt-[22px] pb-[calc(96px+env(safe-area-inset-bottom))] min-[800px]:pb-[60px]">
        <div className="grid gap-8 min-[1000px]:grid-cols-[minmax(0,1fr)_300px]">
          <section className="flex min-w-0 flex-col gap-7">
            <div>
              <h1 className="text-[22px] font-bold tracking-[-.03em]">{dateLine()}</h1>
              <div className="mt-1 text-sm text-muted">
                {!loaded
                  ? "…"
                  : needs
                    ? `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you`
                    : "Nothing needs you."}
              </div>
              {error && <div className="mt-1 font-mono text-[12px] text-fail">{error}</div>}
            </div>

            {loaded && needs > 0 && (
              <div>
                <Label>Needs you</Label>
                <div className="flex flex-col gap-1.5">
                  {waiting.map((s) => (
                    <Need
                      key={s.id}
                      to={`/s/${s.id}`}
                      chip="wait"
                      text={`${s.project}: ${s.title}`}
                    />
                  ))}
                  {flagged.map((r) => (
                    <Need
                      key={r.scheduleId}
                      to={r.sessionId ? `/s/${r.sessionId}` : "/runs"}
                      chip={r.outcome === "failed" ? "fail" : "wait"}
                      text={`${r.schedule}: ${oneLine(r.report ?? r.error ?? "")}`}
                      runs={streak(runs ?? [], r)}
                      onDismiss={() => void dismiss(r)}
                    />
                  ))}
                  {proposals > 0 && (
                    <Need
                      to="/runs"
                      chip="wait"
                      text={`${proposals} proposed memor${proposals === 1 ? "y" : "ies"} to keep or drop`}
                    />
                  )}
                </div>
              </div>
            )}

            {cards.length > 0 && (
              <div>
                <Label>Proposed</Label>
                <div className="flex flex-col gap-2">
                  {cards.map((p) => (
                    <div key={p.id}>
                      <div className="text-[13.5px] font-medium">{p.title}</div>
                      <ProposalCard item={p} onChange={refreshFeed} />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {sources?.calendar && (
              <div>
                <Label>Today</Label>
                {events?.length ? (
                  <div className="flex flex-col gap-1.5">
                    {events.map((e) => (
                      <div
                        key={`${e.uid}-${e.start}`}
                        className="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2 text-[13.5px]"
                      >
                        <span className="w-[3.2rem] flex-none font-mono text-[12px] text-muted">
                          {e.allDay ? "all day" : timeOf(e.start)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{e.summary}</span>
                        {e.url ? (
                          <a
                            href={e.url}
                            target="_blank"
                            rel="noreferrer"
                            className="flex-none font-mono text-[11px] text-accent hover:underline"
                          >
                            join ↗
                          </a>
                        ) : (
                          e.location && (
                            <span className="max-w-[9rem] flex-none truncate font-mono text-[11px] text-faint">
                              {e.location}
                            </span>
                          )
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-[13px] text-faint">
                    {events === null ? "reading…" : "nothing on the calendar"}
                  </div>
                )}
              </div>
            )}

            {open.length > 0 && (
              <div>
                <Label>Open</Label>
                <div className="flex flex-col gap-1.5">
                  {open.slice(0, 6).map((l) => {
                    const source = sourceLabel(l, items);
                    return (
                      <div
                        key={l.slug}
                        className="flex items-center rounded-lg border border-line bg-surface text-[13.5px] hover:border-line-strong"
                      >
                        <Link
                          to={l.from ? `/runs#${l.from}` : "/runs"}
                          className="tap flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2"
                        >
                          <span className="min-w-0 truncate">{l.what}</span>
                          {source && (
                            <span className="flex-none font-mono text-[11.5px] text-faint">
                              {source}
                            </span>
                          )}
                          {l.due && (
                            <span className="ml-auto flex-none font-mono text-[11px] text-wait">
                              {l.due}
                            </span>
                          )}
                        </Link>
                        <button
                          onClick={() => void closeLoop(l.slug)}
                          title="close this loop"
                          aria-label={`close ${l.what}`}
                          className="tap flex-none px-2.5 py-2 text-muted hover:text-wait"
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                  {open.length > 6 && (
                    <Link to="/runs" className="font-mono text-[11px] text-faint hover:text-accent">
                      and {open.length - 6} more →
                    </Link>
                  )}
                </div>
              </div>
            )}

            <div>
              <Label>{brief ? `From ${name}` : "Brief"}</Label>
              {brief ? (
                <div className="rounded-xl border border-accent/30 bg-accent-tint px-4 py-3">
                  <div className="mb-2 flex items-center gap-2 font-mono text-[11px] text-faint">
                    <StatusChip kind={OUTCOME[brief.outcome] ?? "idle"} label={brief.outcome} />
                    <span className="truncate">{brief.schedule}</span>
                    <span className="ml-auto flex flex-none items-center gap-2">
                      {canSpeak() && (
                        <button
                          onClick={() => {
                            if (speech.speaking) {
                              speech.cancelSpeech();
                              return;
                            }
                            unlockAudio();
                            speech.speak(brief.report ?? "");
                          }}
                          className="tap rounded-md border border-line px-2 py-0.5 text-muted hover:border-line-strong hover:text-text"
                          title={speech.speaking ? "stop reading" : "read the brief aloud"}
                        >
                          {speech.speaking ? "stop" : "read aloud"}
                        </button>
                      )}
                      <span>{agoLabel(brief.at)}</span>
                    </span>
                  </div>
                  <div className="text-[14px]">
                    <Markdown components={MD}>{cite(brief.report ?? "")}</Markdown>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-line bg-surface px-4 py-3 text-[13.5px] text-muted">
                  No brief yet. A morning briefing is an assistant schedule with a standing
                  question;{" "}
                  <Link to="/settings" className="text-accent hover:underline">
                    set one up
                  </Link>{" "}
                  and it lands here.
                </div>
              )}
            </div>

            {profile !== null && profile !== undefined && !profile.text.trim() && (
              <Link
                to="/settings#profile"
                className="tap flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3 hover:border-accent-pastel"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">
                    Tell {name} about yourself
                  </span>
                  <span className="block text-[12.5px] text-faint">
                    Who matters, what recurs, what counts as urgent. Read at the start of every
                    conversation.
                  </span>
                </span>
                <span className="flex-none text-[13px] text-faint">→</span>
              </Link>
            )}

            <div className="min-[1000px]:hidden">
              <Running sessions={running} />
            </div>

            <div className="sticky bottom-[calc(64px+env(safe-area-inset-bottom))] min-[800px]:bottom-4">
              <Composer name={name} />
            </div>
          </section>

          <aside className="hidden min-[1000px]:flex min-[1000px]:flex-col min-[1000px]:gap-7">
            <Running sessions={running} />
            <div>
              <Label>Inbox</Label>
              {newest.length ? (
                <div className="flex flex-col gap-1.5">
                  {newest.map((i) => (
                    <Link
                      key={i.id}
                      to={`/runs#${i.id}`}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 hover:border-line-strong"
                    >
                      <span
                        className={`h-1.5 w-1.5 flex-none rounded-full ${
                          i.urgency === "attention"
                            ? "bg-wait"
                            : i.urgency === "new"
                              ? "bg-accent"
                              : "bg-idle"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{i.title}</span>
                      <span className="flex-none font-mono text-[11px] text-faint">{i.source}</span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-faint">nothing new</div>
              )}
            </div>
            <div>
              <Label>Sources</Label>
              <div className="flex flex-col gap-1">
                {(
                  [
                    // The poller files one item when it cannot read github and
                    // resolves it when it can again; that is the only truth
                    // about this source the screen has, and it is the right one.
                    ["github", !ghDown],
                    ["mail", sources?.mail ?? false],
                    ["calendar", sources?.calendar ?? false],
                    ["documents", sources?.docs ?? false],
                  ] as [string, boolean][]
                ).map(([name, on]) => (
                  <Link
                    key={name}
                    // The documents are the one source with somewhere of their
                    // own to go: the share, browsable. The rest are a light and
                    // a link to where the credential is typed.
                    to={name === "documents" && on ? "/docs" : "/settings"}
                    className="flex items-center gap-2 px-1 py-0.5 font-mono text-[12px] text-muted hover:text-text"
                    title={
                      name === "documents" && on
                        ? "browse the share"
                        : on
                          ? "set up"
                          : "not set up: tap to add the credential"
                    }
                  >
                    <span
                      className={`h-1.5 w-1.5 flex-none rounded-full ${on ? "bg-run" : "bg-idle"}`}
                    />
                    {name}
                  </Link>
                ))}
              </div>
            </div>
            <div>
              <Label>Recent runs</Label>
              {runs?.length ? (
                <div className="flex flex-col gap-1.5">
                  {runs.slice(0, 6).map((r) => (
                    <Link
                      key={`${r.scheduleId}-${r.at}`}
                      to={r.sessionId ? `/s/${r.sessionId}` : "/runs"}
                      className="flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2 hover:border-line-strong"
                    >
                      <StatusChip kind={OUTCOME[r.outcome] ?? "idle"} label={r.outcome} />
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">{r.schedule}</span>
                      <span className="flex-none font-mono text-[11px] text-faint">
                        {agoLabel(r.at)}
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-faint">nothing has run yet</div>
              )}
            </div>
          </aside>
        </div>
      </main>
      <Tabs />
    </div>
  );
}

function Running({ sessions }: { sessions: Session[] }) {
  return (
    <div>
      <Label>Running</Label>
      {sessions.length ? (
        <div className="flex flex-col gap-1.5">
          {sessions.map((s) => (
            <Link
              key={s.id}
              to={`/s/${s.id}`}
              className="tap flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 hover:border-accent-pastel"
            >
              <AgentMark agent={s.agent} />
              <span className="max-w-[7.5rem] flex-none truncate text-[11px] font-semibold tracking-[.06em] text-faint uppercase">
                {s.project}
              </span>
              <span className="min-w-0 flex-1 truncate text-[13.5px]">{s.title}</span>
            </Link>
          ))}
        </div>
      ) : (
        <div className="text-[13px] text-faint">nothing running</div>
      )}
    </div>
  );
}
