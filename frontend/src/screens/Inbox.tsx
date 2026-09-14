import { useEffect, useState } from "react";
import { Link } from "react-router";
import type { FeedItem, FeedSource, Loop, Session } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import BandHeading from "../components/BandHeading";
import type { IconName } from "../components/Icon";
import PageHeader from "../components/PageHeader";
import { uncite } from "../components/chat/cite";
import ProposalCard from "../components/ProposalCard";
import Sheet from "../components/Sheet";
import SourceMark from "../components/SourceMark";
import { StatusChip } from "../components/StatusChip";
import Tabs from "../components/Tabs";
import Skeleton from "../components/Skeleton";
import TopBar from "../components/TopBar";
import WaitingSession from "../components/WaitingSession";
import { useConfirm } from "../useConfirm";

/**
 * The inbox: everything that happened, newest first, and what to do with it.
 *
 * One list over every source rather than a section per kind: a review
 * request, a mail, a run that failed and a proposed memory are all things that
 * arrived and want a decision, and the decision is the same four for all of
 * them: done, snooze, not important, why is this here. What differs per source
 * is the one action that ends it, and that is drawn on the row.
 */
const URGENCY: Record<FeedItem["urgency"], { kind: "wait" | "idle" | "run"; label: string }> = {
  attention: { kind: "wait", label: "needs you" },
  new: { kind: "run", label: "new" },
  quiet: { kind: "idle", label: "quiet" },
};

const SOURCES: FeedSource[] = [
  "github",
  "mail",
  "calendar",
  "finance",
  "docs",
  "bench",
  "schedule",
  "memory",
  "paper",
  "intake",
  "proposal",
];

/** A wall-clock time n days from now, in this device's zone. */
function at(days: number, hour: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * When an item can come back. Tomorrow at seven was the only answer this
 * offered, and it is the wrong one for a thing that wants an evening, or that
 * wants to be out of the way until Monday.
 *
 * Computed on the tap rather than at module load, so a tab left open
 * overnight does not offer yesterday's evening.
 */
function snoozeChoices(): { label: string; at: Date }[] {
  const now = new Date();
  const evening = at(0, 18);
  /** The next such weekday, never today. */
  const nextDay = (weekday: number, hour: number) =>
    at((weekday - now.getDay() + 7) % 7 || 7, hour);
  return [
    ...(evening > now ? [{ label: "this evening", at: evening }] : []),
    { label: "tomorrow morning", at: at(1, 7) },
    { label: "the weekend", at: nextDay(6, 9) },
    { label: "next week", at: nextDay(1, 7) },
  ];
}

/** Which day's heading an item belongs under. */
function dayLabel(iso: string): string {
  const day = new Date(iso);
  day.setHours(0, 0, 0, 0);
  const days = Math.round((at(0, 0).getTime() - day.getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

/** The list, cut into days, in the order the feed already had. */
function byDay(items: FeedItem[]): { label: string; items: FeedItem[] }[] {
  const days: { label: string; items: FeedItem[] }[] = [];
  for (const item of items) {
    const label = dayLabel(item.at);
    const last = days.at(-1);
    if (last?.label === label) last.items.push(item);
    else days.push({ label, items: [item] });
  }
  return days;
}

/**
 * Whether the detail line is the facts line in a sentence.
 *
 * The pollers used to write both from the same words — a github row read
 * "PullRequest, on something you watch" twice, once as prose and once as
 * facts. They no longer do, but an item is only rewritten when its version
 * moves on, so the ones filed in between keep the pair for as long as they
 * live, and triage does not always replace a detail it was given. Cheaper to
 * notice here than to rewrite the volume, and it covers every item at once.
 */
export function saysTheSame(item: FeedItem): boolean {
  if (!item.facts.length || !item.detail) return false;
  const plain = (s: string) => s.toLowerCase().replace(/[,·]/g, " ").replace(/\s+/g, " ").trim();
  const detail = plain(item.detail);
  // All of them, which is what a github row was — and any one of them, which is
  // what a mail row became: the old detail was the sender's address, and the
  // facts are that address and the word unread, so the two never matched whole.
  return item.facts.some((f) => plain(f) === detail) || plain(item.facts.join(" ")) === detail;
}

function Row({
  item,
  session,
  loopTitle,
  onChange,
  onActed,
}: {
  item: FeedItem;
  session?: Session;
  /** The words of the loop this item is filed under, when it still exists. */
  loopTitle?: string;
  onChange: () => void;
  /** What just happened to which items, so the screen can offer it back. */
  onActed: (ids: string[], label: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [snoozing, setSnoozing] = useState(false);
  const external = item.link?.startsWith("http");
  const u = URGENCY[item.urgency];
  const done = item.state === "done";

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await fn();
      onChange();
    } finally {
      setBusy(false);
    }
  }
  const setState = (state: FeedItem["state"], until?: string) =>
    act(() =>
      api(`/api/feed/${encodeURIComponent(item.id)}/state`, {
        method: "POST",
        body: JSON.stringify(until ? { state, until } : { state }),
      }),
    );

  const snooze = (choice: { label: string; at: Date }) =>
    void setState("snoozed", choice.at.toISOString()).then(() => {
      setSnoozing(false);
      onActed([item.id], `snoozed until ${choice.label}`);
    });
  const review = (keep: boolean) =>
    act(() =>
      api(
        keep
          ? `/api/memory/proposed/${item.id.slice(7)}/keep`
          : `/api/memory/proposed/${item.id.slice(7)}`,
        { method: keep ? "POST" : "DELETE" },
      ),
    );

  const button =
    "tap rounded-[7px] border border-line px-2.5 py-1.5 font-mono text-[12px] text-muted hover:border-faint hover:text-text disabled:opacity-50";

  return (
    <div
      id={item.id}
      className={`group rounded-[11px] border px-3 py-2 ${
        done
          ? "border-line/60 bg-surface/60 opacity-70"
          : item.urgency === "attention"
            ? "border-wait/30 bg-wait/8"
            : "border-line bg-surface"
      }`}
    >
      <div className="flex items-start gap-2.5">
        {/* The source, as a shape. It was the word `mail` in 11px grey at the
            end of a chip row, which is somewhere the eye arrives rather than
            lands; here it is the first thing on the row and the column the eye
            reads down. Its colour is the urgency, so a row that needs you says
            so before the chip is read. */}
        <SourceMark
          source={item.source}
          className={`mt-[3px] ${
            done
              ? "text-faint"
              : item.urgency === "attention"
                ? "text-wait"
                : item.urgency === "new"
                  ? "text-accent"
                  : "text-faint"
          }`}
        />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="min-w-0 flex-1 text-left"
        >
          {/* Who it is from, ahead of the subject and lighter: six rows of
              "review PR" are six different repositories, and a mail without
              its sender is a subject line from nobody. */}
          <span className={`block text-[13.5px] ${open ? "" : "truncate"}`}>
            {item.from && <span className="text-muted">{item.from} · </span>}
            <span className="font-medium">{item.title}</span>
          </span>
          {item.detail && item.source !== "proposal" && !saysTheSame(item) && (
            /* A scheduled run is asked to cite what it read, and this row is one
               truncated line with nowhere to put a chip: the brackets came out
               here rather than being read as "open square bracket session". The
               row already links to the thing they point at. */
            <span className={`block text-[12.5px] text-muted ${open ? "" : "truncate"}`}>
              {uncite(item.detail)}
            </span>
          )}
          {item.facts.length > 0 && (
            <span className="mt-0.5 flex flex-wrap gap-x-3 font-mono text-[11px] text-faint">
              {item.facts.map((f) => (
                <span key={f}>{f}</span>
              ))}
            </span>
          )}
        </button>
        <span className="flex flex-none items-center gap-2">
          {/* Only when it says something. The urgency is already the section
              the row is in and the mark's colour, and a "needs you" chip under
              a "Needs you" heading cost the title most of a phone's width. */}
          {(done || item.state === "snoozed") && (
            <StatusChip kind={done ? "idle" : u.kind} label={done ? "done" : "snoozed"} />
          )}
          <span className="font-mono text-[11px] text-faint">{agoLabel(item.at)}</span>
        </span>
      </div>
      {/* A proposal is shown whole, with the tap; done and snooze do not apply. */}
      {item.source === "proposal" && <ProposalCard item={item} onChange={onChange} />}
      {(item.loop || item.did) && (
        <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-faint">
          {item.loop && <span>loop: {loopTitle ?? item.loop.replace(/-/g, " ")}</span>}
          {item.did && <span>did: {item.did}</span>}
        </div>
      )}
      {/* A session waiting on you is answered here, without a terminal. */}
      {open && session && session.status === "waiting" && (
        <div className="mt-2">
          <WaitingSession session={session} />
        </div>
      )}
      {/* The buttons cost every row a line of its own, on a screen whose job is
          to be scrolled. They come back on the row under the pointer, and on
          the row you tapped — which is the only one of the two a phone has. */}
      <div
        className={`mt-2 flex-wrap items-center gap-2 ${open ? "flex" : "hidden group-hover:flex"}`}
      >
        {item.link &&
          (external ? (
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[12px] text-accent hover:underline"
            >
              open ↗
            </a>
          ) : (
            <Link to={item.link} className="font-mono text-[12px] text-accent hover:underline">
              open →
            </Link>
          ))}
        <span className="ml-auto flex flex-wrap gap-2">
          {item.source === "memory" && !done && (
            <>
              <button
                onClick={() => void review(true)}
                disabled={busy}
                className="tap rounded-[7px] bg-accent px-2.5 py-1.5 font-mono text-[12px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
              >
                keep
              </button>
              <button onClick={() => void review(false)} disabled={busy} className={button}>
                drop
              </button>
            </>
          )}
          {!done && item.state !== "snoozed" && item.source !== "proposal" && (
            <button
              onClick={() => setSnoozing(true)}
              disabled={busy}
              className={button}
              title="put it away until later"
            >
              snooze
            </button>
          )}
          {!done && item.source === "proposal" ? null : !done ? (
            <button
              onClick={() => void setState("done").then(() => onActed([item.id], "marked done"))}
              disabled={busy}
              className={button}
            >
              done
            </button>
          ) : (
            <button onClick={() => void setState("new")} disabled={busy} className={button}>
              reopen
            </button>
          )}
        </span>
      </div>
      {snoozing && (
        <Sheet title="Bring it back" sub={item.title} onClose={() => setSnoozing(false)}>
          <div className="flex flex-col gap-2">
            {snoozeChoices().map((choice) => (
              <button
                key={choice.label}
                onClick={() => snooze(choice)}
                disabled={busy}
                className="tap flex items-center gap-2.5 rounded-lg border border-line bg-surface-2 px-3 py-2.5 text-left text-[13.5px] hover:border-faint disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">{choice.label}</span>
                <span className="flex-none font-mono text-[11.5px] text-faint">
                  {choice.at.toLocaleString(undefined, {
                    weekday: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </button>
            ))}
          </div>
        </Sheet>
      )}
    </div>
  );
}

export default function Inbox() {
  const { data: items, refresh } = usePoll<FeedItem[]>("/api/feed", 15_000);
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 8_000);
  const { data: loops } = usePoll<Loop[]>("/api/loops", 60_000);
  const [source, setSource] = useState<FeedSource | "all">("all");
  const [showDone, setShowDone] = useState(false);
  // Quiet items are the routine: shown on asking, so the ones that matter are
  // not a scroll down past thirty of them.
  const [showQuiet, setShowQuiet] = useState(false);
  const [judging, setJudging] = useState(false);
  const [clearing, setClearing] = useState(false);
  // What the last action did, and the way back out of it. An inbox where
  // "done" is one tap and irreversible is one you stop trusting to tap in.
  const [undo, setUndo] = useState<{ ids: string[]; label: string } | null>(null);
  const [confirm, confirmDialog] = useConfirm();

  // Offered for as long as it is plausibly still the thing you just did.
  useEffect(() => {
    if (!undo) return;
    const timer = setTimeout(() => setUndo(null), 15_000);
    return () => clearTimeout(timer);
  }, [undo]);

  const all = items ?? [];
  const live = all.filter((i) => i.state !== "done");
  // What the chips are counting, and therefore what decides whether there is a
  // chip at all: a source whose every item is done offered a filter reading
  // "bench 0", which is a button that leads to an empty list.
  const counted = showDone ? all : live;
  const present = SOURCES.filter((s) => counted.some((i) => i.source === s));
  const shown = all
    .filter((i) => showDone || i.state !== "done")
    .filter((i) => source === "all" || i.source === source);
  // A proposal ends by being taken or dropped on its own card, so it is not
  // one of the things "clear" is offering to clear.
  const clearable = shown.filter((i) => i.state !== "done" && i.source !== "proposal");
  const attention = live.filter((i) => i.urgency === "attention").length;
  const unjudged = live.filter((i) => !i.triaged).length;
  const open = (loops ?? []).filter((l) => l.state === "open");
  const loopWhat = new Map((loops ?? []).map((l) => [l.slug, l.what]));
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));

  /**
   * The list in sections by what it asks of you, each still cut into days.
   *
   * One run of rows ordered by time put a failed deploy between two newsletters,
   * and the only mark telling them apart was a small chip on each. Sections by
   * urgency answer "what do I have to look at" before "when did it arrive".
   */
  const pending = shown.filter((i) => i.state !== "done");
  const sections: { key: string; icon: IconName; title: string; items: FeedItem[] }[] = [
    {
      key: "attention",
      icon: "alert",
      title: "Needs you",
      items: pending.filter((i) => i.urgency === "attention"),
    },
    { key: "new", icon: "inbox", title: "New", items: pending.filter((i) => i.urgency === "new") },
    {
      key: "quiet",
      icon: "history",
      title: "Quiet",
      items: pending.filter((i) => i.urgency === "quiet"),
    },
    { key: "done", icon: "check", title: "Done", items: shown.filter((i) => i.state === "done") },
  ];

  /**
   * Every item on the list as it is filtered, in one go.
   *
   * The list is one row per thing that arrived, and on a morning after a busy
   * night that is thirty rows of quiet ones between the two that matter. The
   * filter above decides what "all of them" means, so this clears a source at
   * a time as readily as the lot.
   */
  async function clearShown(items: FeedItem[]) {
    const ok = await confirm({
      title: `Mark ${items.length} items done?`,
      body: "They leave the list. Done keeps thirty days, and undo is on the next screen.",
      action: `mark ${items.length} done`,
    });
    if (!ok) return;
    setClearing(true);
    try {
      // One at a time: this is a write per item on the pod's volume, and
      // thirty at once buys nothing on a list nobody is watching finish.
      for (const item of items) {
        await api(`/api/feed/${encodeURIComponent(item.id)}/state`, {
          method: "POST",
          body: JSON.stringify({ state: "done" }),
        });
      }
      setUndo({ ids: items.map((i) => i.id), label: `${items.length} marked done` });
    } finally {
      setClearing(false);
      refresh();
    }
  }

  async function undoLast() {
    if (!undo) return;
    const { ids } = undo;
    setUndo(null);
    for (const id of ids) {
      await api(`/api/feed/${encodeURIComponent(id)}/state`, {
        method: "POST",
        body: JSON.stringify({ state: "new" }),
      });
    }
    refresh();
  }

  async function judge() {
    if (judging) return;
    setJudging(true);
    try {
      await api("/api/feed/triage", { method: "POST", timeoutMs: 6 * 60_000 });
      refresh();
    } finally {
      setJudging(false);
    }
  }

  return (
    <>
      <TopBar crumb={[{ label: "inbox" }]} />
      <main className="mx-auto max-w-[900px] px-[18px] pt-[22px] pb-[calc(80px+env(safe-area-inset-bottom))] min-[800px]:pb-[60px]">
        <PageHeader
          icon="inbox"
          label="Inbox"
          title={
            items === null ? (
              <Skeleton className="inline-block h-[22px] w-48 max-w-full rounded-md bg-surface-2 align-middle" />
            ) : attention ? (
              `${attention} need${attention === 1 ? "s" : ""} you`
            ) : (
              "Nothing needs you"
            )
          }
          sub="Everything that arrived, sorted by what it asks of you. Done keeps thirty days, undo is on the next screen, and snooze asks when to bring it back."
        />

        {open.length > 0 && (
          <section className="mb-8">
            <BandHeading icon="proposal" title="Open loops" count={open.length} />
            <div className="flex flex-col gap-1.5">
              {open.map((l) => (
                <div
                  key={l.slug}
                  className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]"
                >
                  {/* Breaks anywhere: a file path is one long word, and one
                      that cannot break was drawn over the due date beside it. */}
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.what}</span>
                  {l.due && <span className="font-mono text-[11px] text-wait">due {l.due}</span>}
                  <button
                    onClick={() =>
                      void api(`/api/loops/${l.slug}/close`, { method: "POST" }).then(() =>
                        refresh(),
                      )
                    }
                    className="tap rounded-[7px] border border-line px-2 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
                  >
                    close
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* The filters and the list's own actions in one bar of their own, so
            they read as controls rather than as the first row of the list.
            On a phone the actions get a row of their own under a rule: left
            to wrap, they landed alone on a third line under the chips. */}
        <div className="mb-7 flex flex-col gap-2 rounded-xl border border-line bg-surface px-2.5 py-2 min-[800px]:flex-row min-[800px]:items-center">
          <div className="flex flex-wrap items-center gap-1.5">
            {(["all", ...present] as (FeedSource | "all")[]).map((s) => (
              <button
                key={s}
                onClick={() => setSource(s)}
                aria-pressed={source === s}
                className={`tap rounded-full border px-2.5 py-1 font-mono text-[11px] ${
                  source === s
                    ? "border-accent/50 text-accent"
                    : "border-line text-faint hover:border-line-strong"
                }`}
              >
                {s !== "all" && (
                  <SourceMark source={s} className="mr-1.5 inline-block align-[-2px]" />
                )}
                {s}
                {/* What is behind the chip, so a filter can be chosen rather than
                  tried. Counted over what is live, which is what the list is
                  showing unless done is switched on. */}
                <span className="ml-1.5 text-line-strong">
                  {s === "all" ? counted.length : counted.filter((i) => i.source === s).length}
                </span>
              </button>
            ))}
          </div>
          <span className="flex items-center gap-2 border-t border-line pt-2 min-[800px]:ml-auto min-[800px]:border-0 min-[800px]:pt-0">
            {unjudged > 0 && (
              <button
                onClick={() => void judge()}
                disabled={judging}
                className="tap rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
                title="ask the assistant to sort what has not been sorted yet"
              >
                {judging ? "sorting…" : `sort ${unjudged} new`}
              </button>
            )}
            {clearable.length > 1 && (
              <button
                onClick={() => void clearShown(clearable)}
                disabled={clearing}
                className="tap rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text disabled:opacity-50"
                title="mark everything on this list done"
              >
                {clearing ? "clearing…" : `clear ${clearable.length}`}
              </button>
            )}
            <button
              onClick={() => setShowDone((d) => !d)}
              aria-pressed={showDone}
              className={`tap rounded-[7px] border px-2.5 py-1 font-mono text-[11px] ${
                showDone ? "border-accent/50 text-accent" : "border-line text-faint"
              }`}
            >
              done
            </button>
          </span>
        </div>

        {undo && (
          <div className="mb-3 flex items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]">
            <span className="min-w-0 flex-1 text-muted">{undo.label}</span>
            <button
              onClick={() => void undoLast()}
              className="tap flex-none rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11.5px] text-muted hover:border-faint hover:text-text"
            >
              undo
            </button>
          </div>
        )}

        {sections.map((s) => {
          if (!s.items.length) return null;
          const folded = s.key === "quiet" && !showQuiet;
          return (
            <section key={s.key} className="mb-8">
              <BandHeading
                icon={s.icon}
                title={s.title}
                count={s.items.length}
                action={
                  s.key === "quiet" ? (
                    <button
                      onClick={() => setShowQuiet((q) => !q)}
                      aria-expanded={showQuiet}
                      className="tap flex-none rounded-[7px] border border-line px-2.5 py-1 font-mono text-[11px] text-muted hover:border-faint hover:text-text"
                    >
                      {showQuiet ? "hide" : "show"}
                    </button>
                  ) : undefined
                }
              />
              {!folded && (
                <div className="flex flex-col gap-2">
                  {/* Still cut into days inside a section: "when did this
                      arrive" is most of what tells the overnight ones apart. */}
                  {byDay(s.items).map((day) => (
                    <div key={day.label} className="flex flex-col gap-2">
                      <div className="mt-2 font-mono text-[11px] tracking-[.12em] text-faint uppercase first:mt-0">
                        {day.label}
                      </div>
                      {day.items.map((i) => (
                        <Row
                          key={i.id}
                          item={i}
                          session={
                            i.id.startsWith("bench:wait:") ? byId.get(i.id.slice(11)) : undefined
                          }
                          loopTitle={i.loop ? loopWhat.get(i.loop) : undefined}
                          onChange={refresh}
                          onActed={(ids, label) => setUndo({ ids, label })}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>
          );
        })}
        {items === null && (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <Skeleton
                key={i}
                className="block h-[72px] rounded-xl border border-line bg-surface"
              />
            ))}
          </div>
        )}
        {items !== null && shown.length === 0 && (
          <div className="font-mono text-[12.5px] text-faint">
            nothing here — schedules, GitHub and the agents all land in this list
          </div>
        )}
      </main>
      <Tabs />
      {confirmDialog}
    </>
  );
}
