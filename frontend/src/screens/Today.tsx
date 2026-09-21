import { useState } from "react";
import Markdown from "react-markdown";
import { Link, useNavigate } from "react-router";
import { ackToday, ackedToday } from "../todayAck";
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
import { cite, citeUrl } from "../components/chat/cite";
import { MD, REMARK } from "../components/chat/markdown";
import Icon, { type IconName } from "../components/Icon";
import PageHeader from "../components/PageHeader";
import PollError from "../components/PollError";
import ProposalCard from "../components/ProposalCard";
import Sheet from "../components/Sheet";
import { AgentMark, StatusChip } from "../components/StatusChip";
import { useUndo } from "../components/UndoBar";
import Tabs from "../components/Tabs";
import Skeleton from "../components/Skeleton";
import TopBar from "../components/TopBar";
import { useGrow } from "../useGrow";
import { canSpeak, useSpeech } from "../useSpeech";

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
function Label({ children, icon }: { children: string; icon?: IconName }) {
  return (
    <div className="mb-2 flex items-center gap-1.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
      {icon && <Icon name={icon} size={13} />}
      {children}
    </div>
  );
}

/** Which icon a feed row's source wears, in place of its name in mono. */
const SOURCE_ICON: Record<string, IconName> = {
  github: "github",
  mail: "inbox",
  calendar: "calendar",
  schedule: "history",
  bench: "bench",
  memory: "memory",
  proposal: "proposal",
  docs: "document",
};

/**
 * How long a flagged run is today's business. A day, because that is what this
 * screen is: the schedules that run daily get one morning's grace, and the
 * ones that run weekly stop owning six mornings they have nothing to say on.
 */
const STALE_MS = 24 * 60 * 60_000;

/** Whether a run has aged past that. Module scope, so render stays pure. */
function stale(at: string): boolean {
  return Date.now() - Date.parse(at) >= STALE_MS;
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
 * Where a loop's row goes.
 *
 * A loop opened off the catalogue carries `doc:<path>` rather than a feed item
 * id, and there is no feed item with that id: the row pointed at an anchor on
 * the inbox that nothing answers to, so the one kind of loop whose source is a
 * document was the one kind that went nowhere. It goes to the folder the
 * document is in, which is the screen that can show it.
 */
export function loopLink(from: string | null): string {
  if (!from) return "/runs";
  if (!from.startsWith("doc:")) return `/runs#${from}`;
  const dir = from.slice(4).split("/").slice(0, -1).join("/");
  return dir ? `/docs?path=${encodeURIComponent(dir)}` : "/docs";
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
  /**
   * Whether the answer's sheet is up. Its own state rather than `asked`,
   * because the sheet refused to close while the turn ran — and a turn is
   * allowed eleven minutes. The turn is posted to the thread either way, so
   * putting the sheet away loses nothing; the line under the composer brings
   * it back.
   */
  const [shown, setShown] = useState(false);

  async function send() {
    const value = text.trim();
    if (!value || busy) return;
    setText("");
    setAsked(value);
    setShown(true);
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
            className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent text-[15px] outline-none! placeholder:text-faint"
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
      {asked !== null && !shown && (
        <div className="mt-2 flex items-center gap-2 px-1 text-[12.5px] text-muted">
          {busy && (
            <span className="inline-block h-2 w-2 flex-none animate-pulse rounded-full bg-accent" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {busy ? "working on " : "answered "}“{asked}”
          </span>
          <button
            onClick={() => setShown(true)}
            className="tap flex-none text-accent hover:underline"
          >
            show
          </button>
        </div>
      )}
      {asked !== null && shown && (
        <Sheet title={name} sub={asked} onClose={() => setShown(false)}>
          {busy && (
            <div className="flex items-center gap-2 text-[12.5px] text-muted">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-accent" />
              working…
            </div>
          )}
          {error && <div className="text-[12.5px] text-fail">{error}</div>}
          {reply && (
            <div className="text-[14px]">
              <Markdown components={MD} remarkPlugins={REMARK} urlTransform={citeUrl}>
                {cite(reply)}
              </Markdown>
            </div>
          )}
          <div className="mt-4 flex justify-end">
            <Link to="/ai" className="text-[12.5px] text-accent hover:underline">
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
  const {
    data: feed,
    error: feedError,
    refresh: refreshFeed,
  } = usePoll<FeedItem[]>("/api/feed", 30_000);
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

  /**
   * The two taps on this screen that take something off it. Neither asks
   * first — they are triage, and a question per row is how triage stops
   * happening — so both offer the way back instead (F-30).
   */
  const [offerUndo, undoBar] = useUndo();

  /** A POST, then the list it changed. Says so on the screen if it fails. */
  async function post(url: string, refresh: () => void, body?: unknown): Promise<boolean> {
    try {
      await api(url, {
        method: "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }

  async function dismiss(r: ScheduleRun) {
    const id = r.scheduleId;
    if (await post(`/api/schedules/${id}/dismiss`, refreshRuns, { at: r.at })) {
      offerUndo(`waved off “${r.schedule}”`, () =>
        post(`/api/schedules/${id}/undismiss`, refreshRuns).then(() => undefined),
      );
    }
  }

  async function closeLoop(slug: string, what: string) {
    if (await post(`/api/loops/${slug}/close`, refreshLoops)) {
      offerUndo(`closed “${what}”`, () =>
        post(`/api/loops/${slug}/reopen`, refreshLoops).then(() => undefined),
      );
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
  // verdict already waved off, until the schedule says something else. And
  // never one from before today: a weekly scout that failed on Sunday was on
  // this list every morning until the next Sunday, pointing at a session that
  // ended days ago with nothing in it to read. It stays in the inbox and in
  // recent runs, where a thing you did not get to belongs.
  const flagged = [...newestRun.values()].filter(
    (r) =>
      (r.outcome === "attention" || r.outcome === "failed") &&
      r !== brief &&
      !r.dismissed &&
      !stale(r.at),
  );
  const loaded = sessions !== null && runs !== null;
  const navigate = useNavigate();
  // Once acknowledged, "/" goes to the bench for the rest of the day; the
  // button becomes a quiet mark so Today opened from its tab says it was seen.
  const [acked, setAcked] = useState(ackedToday);
  const needs = waiting.length + flagged.length + (proposals ? 1 : 0);

  return (
    <div className="flex min-h-full flex-col">
      <TopBar crumb={[{ label: "today" }]} />
      <main className="mx-auto w-full max-w-[1100px] flex-1 px-[18px] pt-[22px] pb-[calc(96px+env(safe-area-inset-bottom))] min-[800px]:pb-[60px]">
        {/* Above both columns, as every page's header is: the date is the
            page's headline, and "Got it" is its one button. */}
        <PageHeader
          icon="today"
          label="Today"
          title={dateLine()}
          sub={
            <>
              {!loaded ? (
                <Skeleton className="inline-block h-3.5 w-40 rounded bg-surface-2 align-middle" />
              ) : needs ? (
                `${needs} thing${needs === 1 ? "" : "s"} need${needs === 1 ? "s" : ""} you`
              ) : (
                "Nothing needs you."
              )}
              {error && <div className="mt-1 text-[12.5px] text-fail">{error}</div>}
            </>
          }
          actions={
            acked ? (
              <span
                title="acknowledged today: opening verksted goes to the bench until tomorrow"
                className="flex flex-none items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] text-faint"
              >
                <Icon name="check" size={14} />
                seen today
              </span>
            ) : (
              <button
                onClick={() => {
                  ackToday();
                  setAcked(true);
                  void navigate("/bench");
                }}
                title="done with today: opening verksted goes to the bench until tomorrow"
                className="tap flex flex-none items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-on-accent hover:brightness-110"
              >
                <Icon name="check" size={15} />
                Got it
              </button>
            )
          }
        />
        {/* "Nothing needs you" is a claim about the feed, and a feed that
            could not be read is not the same claim. */}
        <PollError error={feedError} what="what arrived" retry={refreshFeed} />

        <div className="grid gap-8 min-[1000px]:grid-cols-[minmax(0,1fr)_312px] min-[1000px]:gap-10">
          <section className="flex min-w-0 flex-col gap-7">
            {/* At the top and in place. Stuck to the bottom it followed the
                scroll and sat over whatever list was passing under it. */}
            <Composer name={name} />

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
                            className="flex-none text-[11.5px] text-accent hover:underline"
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
                ) : events === null ? (
                  <div className="flex flex-col gap-1.5">
                    {[0, 1].map((i) => (
                      <Skeleton key={i} className="block h-9 rounded-lg bg-surface-2" />
                    ))}
                  </div>
                ) : (
                  <div className="text-[13px] text-faint">nothing on the calendar</div>
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
                          to={loopLink(l.from)}
                          className="tap flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2"
                        >
                          <span className="min-w-0 truncate">{l.what}</span>
                          {/* Capped and truncated: for an item that is not a PR
                              this is the item's title, which can be a sentence,
                              and a flex-none sentence pushed the row past the ×
                              and the page past the screen. */}
                          {source && (
                            <span className="max-w-[45%] flex-none truncate font-mono text-[11.5px] text-faint">
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
                          onClick={() => void closeLoop(l.slug, l.what)}
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
                    <Link to="/runs" className="text-[11.5px] text-faint hover:text-accent">
                      and {open.length - 6} more →
                    </Link>
                  )}
                </div>
              </div>
            )}

            {/* The one piece of prose on a screen of lists, and it read as a
                fourth list: the same micro-label, the same card, four sections
                down. A rule and a heading of its own say where the lists stop
                and the morning's reading starts. */}
            {/* Only when a list sits above it: with nothing above, the page
                header's own rule is the line, and a second one doubled it. */}
            <div
              className={
                (loaded && needs > 0) || cards.length > 0 || sources?.calendar || open.length > 0
                  ? "border-t border-line pt-6"
                  : ""
              }
            >
              <h2 className="mb-3 flex items-baseline gap-2 text-[16px] font-semibold tracking-[-.02em]">
                The brief
                {brief && (
                  <span className="text-[11.5px] font-normal tracking-normal text-faint">
                    from {name}
                  </span>
                )}
              </h2>
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
                    <Markdown components={MD} remarkPlugins={REMARK} urlTransform={citeUrl}>
                      {cite(brief.report ?? "")}
                    </Markdown>
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
          </section>

          {/* A rule down the side, because the two columns were the same
              cards at the same weight and nothing said which was the screen
              and which was the index beside it. */}
          <aside className="hidden min-[1000px]:flex min-[1000px]:flex-col min-[1000px]:gap-7 min-[1000px]:border-l min-[1000px]:border-line min-[1000px]:pl-8">
            <Running sessions={running} plain />
            <div>
              <Label icon="inbox">Inbox</Label>
              {newest.length ? (
                <div className="flex flex-col gap-1.5">
                  {newest.map((i) => (
                    <Link
                      key={i.id}
                      to={`/runs#${i.id}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface"
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
                      <span className="min-w-0 flex-1 truncate text-[12.5px]">
                        {i.from && <span className="text-faint">{i.from} · </span>}
                        {i.title}
                      </span>
                      <span title={i.source} className="flex-none text-faint">
                        <Icon name={SOURCE_ICON[i.source] ?? "inbox"} size={14} />
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className="text-[13px] text-faint">nothing new</div>
              )}
            </div>
            <div>
              <Label icon="sources">Sources</Label>
              <div className="flex flex-col gap-1">
                {(
                  [
                    // The poller files one item when it cannot read github and
                    // resolves it when it can again; that is the only truth
                    // about this source the screen has, and it is the right one.
                    ["github", !ghDown, "github", sources?.links.github, "/settings?tab=agents"],
                    [
                      "mail",
                      sources?.mail ?? false,
                      "inbox",
                      sources?.links.mail,
                      "/settings?tab=agents",
                    ],
                    [
                      "calendar",
                      sources?.calendar ?? false,
                      "calendar",
                      sources?.links.calendar,
                      "/settings?tab=sources",
                    ],
                    [
                      "documents",
                      sources?.docs ?? false,
                      "document",
                      "/docs",
                      "/settings?tab=agents",
                    ],
                  ] as [string, boolean, IconName, string | undefined, string][]
                ).map(([name, on, icon, home, setup]) => {
                  // A source that is set up opens where it lives: the share in
                  // the app, the rest on their own site in a new tab. One that
                  // is not, or whose site the server cannot name, goes to where
                  // its credential is typed, which is the one useful place.
                  const to = on && home ? home : setup;
                  const outside = to.startsWith("https://");
                  const row = (
                    <>
                      {/* The icon says which source; its colour says whether it
                          is set up — and that was the whole of it. #4a4a4a on
                          the surface is about 2.2:1, so "not set up" was a
                          shade nobody can see, carried by colour alone, on the
                          one row whose job is to say a source is missing. The
                          words are the signal now and the colour agrees with
                          them. */}
                      <Icon name={icon} size={14} className={on ? "text-run" : "text-faint"} />
                      {name}
                      {!on && <span className="text-[11px] text-wait">not set up</span>}
                      {outside && <span className="text-faint">↗</span>}
                    </>
                  );
                  const className =
                    "flex items-center gap-2 px-1 py-0.5 text-[12.5px] text-muted hover:text-text";
                  const title = !on
                    ? "not set up: tap to add it"
                    : outside
                      ? `open ${name}`
                      : name === "documents"
                        ? "browse the share"
                        : "set up";
                  return outside ? (
                    <a
                      key={name}
                      href={to}
                      target="_blank"
                      rel="noreferrer"
                      className={className}
                      title={title}
                    >
                      {row}
                    </a>
                  ) : (
                    <Link key={name} to={to} className={className} title={title}>
                      {row}
                    </Link>
                  );
                })}
              </div>
            </div>
            <div>
              <Label icon="history">Recent runs</Label>
              {runs?.length ? (
                <div className="flex flex-col gap-1.5">
                  {runs.slice(0, 6).map((r) => (
                    <Link
                      key={`${r.scheduleId}-${r.at}`}
                      to={r.sessionId ? `/s/${r.sessionId}` : "/runs"}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface"
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
      {undoBar}
      <Tabs />
    </div>
  );
}

/**
 * What is live. `plain` is the side column's version: a row rather than a card,
 * because beside the inbox and the recent runs it was the one thing still
 * wearing a border, and the odd card out reads as the important one.
 */
function Running({ sessions, plain = false }: { sessions: Session[]; plain?: boolean }) {
  return (
    <div>
      <Label icon="running">Running</Label>
      {sessions.length ? (
        <div className={`flex flex-col ${plain ? "gap-0.5" : "gap-1.5"}`}>
          {sessions.map((s) => (
            <Link
              key={s.id}
              to={`/s/${s.id}`}
              className={`tap flex items-center gap-2.5 ${
                plain
                  ? "rounded-md px-2 py-1.5 hover:bg-surface"
                  : "rounded-lg border border-line bg-surface px-3 py-2 hover:border-accent-pastel"
              }`}
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
