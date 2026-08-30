import { useState } from "react";
import { Link } from "react-router";
import type { FeedItem, FeedSource, Loop, Session } from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import { StatusChip } from "../components/StatusChip";
import Tabs from "../components/Tabs";
import TopBar from "../components/TopBar";
import WaitingSession from "../components/WaitingSession";

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

/** Tomorrow at seven, local: the one snooze everybody wants. */
function tomorrowMorning(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(7, 0, 0, 0);
  return d.toISOString();
}

function Row({
  item,
  session,
  onChange,
}: {
  item: FeedItem;
  session?: Session;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
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
      className={`rounded-[11px] border px-[15px] py-2.5 ${
        done
          ? "border-line/60 bg-surface/60 opacity-70"
          : item.urgency === "attention"
            ? "border-wait/30 bg-wait/8"
            : "border-line bg-surface"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <StatusChip
          kind={done ? "idle" : u.kind}
          label={done ? "done" : item.state === "snoozed" ? "snoozed" : u.label}
        />
        <span className="font-mono text-[11px] text-faint">{item.source}</span>
        <span className="ml-auto font-mono text-[11px] text-faint">{agoLabel(item.at)}</span>
      </div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-1.5 block w-full text-left text-[13.5px] font-medium hover:text-accent"
      >
        {item.title}
      </button>
      {item.detail && (
        <div className={`mt-0.5 text-[12.5px] text-muted ${open ? "" : "line-clamp-2"}`}>
          {item.detail}
        </div>
      )}
      {(item.loop || item.did) && (
        <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-faint">
          {item.loop && <span>loop: {item.loop}</span>}
          {item.did && <span>did: {item.did}</span>}
        </div>
      )}
      {/* A session waiting on you is answered here, without a terminal. */}
      {open && session && session.status === "waiting" && (
        <div className="mt-2">
          <WaitingSession session={session} />
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
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
          {!done && item.state !== "snoozed" && (
            <button
              onClick={() => void setState("snoozed", tomorrowMorning())}
              disabled={busy}
              className={button}
              title="back tomorrow at seven"
            >
              snooze
            </button>
          )}
          {!done ? (
            <button onClick={() => void setState("done")} disabled={busy} className={button}>
              done
            </button>
          ) : (
            <button onClick={() => void setState("new")} disabled={busy} className={button}>
              reopen
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

export default function Inbox() {
  const { data: items, refresh } = usePoll<FeedItem[]>("/api/feed", 15_000);
  const { data: sessions } = usePoll<Session[]>("/api/sessions", 8_000);
  const { data: loops } = usePoll<Loop[]>("/api/loops", 60_000);
  const [source, setSource] = useState<FeedSource | "all">("all");
  const [showDone, setShowDone] = useState(false);
  const [judging, setJudging] = useState(false);

  const all = items ?? [];
  const live = all.filter((i) => i.state !== "done");
  const present = SOURCES.filter((s) => all.some((i) => i.source === s));
  const shown = all
    .filter((i) => showDone || i.state !== "done")
    .filter((i) => source === "all" || i.source === source);
  const attention = live.filter((i) => i.urgency === "attention").length;
  const unjudged = live.filter((i) => !i.triaged).length;
  const open = (loops ?? []).filter((l) => l.state === "open");
  const byId = new Map((sessions ?? []).map((s) => [s.id, s]));

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
        <div className="mb-2.5 font-mono text-[11px] tracking-[.14em] text-faint uppercase">
          Inbox
        </div>
        <h1 className="mb-1 text-[21px] font-semibold tracking-tight">
          {items === null
            ? "…"
            : attention
              ? `${attention} need${attention === 1 ? "s" : ""} you`
              : "nothing needs you"}
        </h1>
        <div className="mb-5 text-sm text-muted">
          Everything that arrived, newest first: what the schedules did, what GitHub wants, what the
          agents are waiting on, what was proposed to remember. Done keeps thirty days; snooze
          brings it back tomorrow at seven.
        </div>

        {open.length > 0 && (
          <div className="mb-6">
            <div className="mb-2 font-mono text-[11px] tracking-[.12em] text-faint uppercase">
              Open loops
            </div>
            <div className="flex flex-col gap-1.5">
              {open.map((l) => (
                <div
                  key={l.slug}
                  className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line bg-surface px-3 py-2 text-[13px]"
                >
                  <span className="min-w-0 flex-1">{l.what}</span>
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
          </div>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-1.5">
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
              {s}
            </button>
          ))}
          <span className="ml-auto flex items-center gap-2">
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

        <div className="flex flex-col gap-2">
          {shown.map((i) => (
            <Row
              key={i.id}
              item={i}
              session={i.id.startsWith("bench:wait:") ? byId.get(i.id.slice(11)) : undefined}
              onChange={refresh}
            />
          ))}
          {items !== null && shown.length === 0 && (
            <div className="font-mono text-[12.5px] text-faint">
              nothing here — schedules, GitHub and the agents all land in this list
            </div>
          )}
        </div>
      </main>
      <Tabs />
    </>
  );
}
