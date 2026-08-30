import { useState } from "react";
import { Link, useNavigate } from "react-router";
import type {
  AssistantThread,
  CouncilMember,
  PodFacts,
  Project,
  Session,
  UsageSummary,
} from "../../../shared/api";
import { agoLabel, api, usePoll } from "../api";
import Portrait from "../components/Face";
import TopBar from "../components/TopBar";
import { AgentMark, AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Sheet, { focusIfPointerFine } from "../components/Sheet";
import UsagePanel from "../components/UsagePanel";

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}G`;
}

/** How a finished session's own verdict maps onto a chip. */
const OUTCOME: Record<string, { kind: "run" | "wait" | "fail" | "idle"; label: string }> = {
  ok: { kind: "run", label: "ok" },
  attention: { kind: "wait", label: "needs a look" },
  failed: { kind: "fail", label: "failed" },
  done: { kind: "idle", label: "done" },
  running: { kind: "run", label: "running" },
};

/**
 * One session as a row you can act on.
 *
 * The title leads and the tmux id sits under it in mono: the id is the join key
 * between the metadata file, tmux and the websocket, which makes it worth
 * showing and worth copying, but it was never what the session is about.
 */
function SessionCard({
  session,
  urgent,
  compact,
}: {
  session: Session;
  urgent?: boolean;
  compact?: boolean;
}) {
  const chip = OUTCOME[session.outcome] ?? OUTCOME.done;
  // One line: the mark, where it is, what it is, and how it went. The id and
  // the age are what a card has room for and a row does not — both are on the
  // session screen, and neither is why you are scanning this list.
  if (compact) {
    return (
      <Link
        to={`/s/${session.id}`}
        className={`tap flex items-center gap-2.5 rounded-lg border px-3 py-2 transition ${
          urgent
            ? "border-wait/30 bg-wait/8 hover:border-wait/60"
            : "border-line bg-surface hover:border-accent-pastel"
        }`}
      >
        <AgentMark agent={session.agent} />
        <span className="sr-only">{session.agent}</span>
        <span className="max-w-[7.5rem] flex-none truncate text-[11px] font-semibold tracking-[.06em] text-faint uppercase">
          {session.project}
        </span>
        <span className="min-w-0 flex-1 truncate text-[14px] font-semibold tracking-[-.014em]">
          {session.title}
        </span>
        {/* First thing to go on a narrow phone: the band it is in already says
            roughly when, and the title is what must not be truncated. */}
        <span className="hidden flex-none text-[11.5px] text-faint min-[420px]:block">
          {agoLabel(session.endedAt ?? session.createdAt)}
        </span>
        <StatusChip kind={urgent ? "wait" : chip.kind} label={urgent ? "answer" : chip.label} />
      </Link>
    );
  }
  return (
    <Link
      to={`/s/${session.id}`}
      className={`tap flex items-center gap-3 rounded-xl border p-3.5 transition hover:-translate-y-px ${
        urgent
          ? "border-wait/30 bg-wait/8 hover:border-wait/60"
          : "border-line bg-surface hover:border-accent-pastel"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="mb-0.5 block text-[11.5px] font-semibold tracking-[.06em] text-faint uppercase">
          {session.project}
        </span>
        <span className="block truncate text-[15px] font-semibold tracking-[-.014em]">
          {session.title}
        </span>
        <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
          <AgentTag agent={session.agent} />
          <span className="font-mono text-[11.5px] text-faint">{session.id}</span>
          <span className="text-[12.5px] text-faint">
            {agoLabel(session.endedAt ?? session.createdAt)}
          </span>
        </span>
      </span>
      <span className="flex-none">
        {urgent ? (
          <span className="rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-on-accent">
            Answer
          </span>
        ) : (
          <StatusChip kind={chip.kind} label={chip.label} />
        )}
      </span>
    </Link>
  );
}

/**
 * One number from the pod, with a meter when it is a share of something.
 *
 * The meter turns amber past three quarters and red past nine tenths: a disk
 * that is nearly full is the one fact on this strip worth interrupting for, and
 * a bar that is always the same colour never says so.
 */
function Stat({
  label,
  value,
  fraction,
}: {
  label: string;
  value: string;
  fraction?: number | null;
}) {
  const pct = fraction == null ? null : Math.min(100, Math.max(0, fraction * 100));
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[11px] font-semibold tracking-[.08em] text-faint uppercase">
        {label}
      </div>
      <div className="truncate text-[15px] font-semibold tabular-nums">{value}</div>
      {pct != null && (
        <div
          className="mt-2 h-[3px] overflow-hidden rounded-full bg-surface-2"
          role="img"
          aria-label={`${Math.round(pct)}% used`}
        >
          <div
            className={`h-full rounded-full ${
              pct >= 90 ? "bg-fail" : pct >= 75 ? "bg-wait" : "bg-muted"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

const COLS_ROOMY = "grid-cols-[repeat(auto-fill,minmax(min(280px,100%),1fr))]";
const COLS_COMPACT = "grid-cols-[repeat(auto-fill,minmax(min(420px,100%),1fr))]";

/**
 * List density, remembered per device.
 *
 * A phone starts compact: the roomy card is 86px, which is four sessions to a
 * screen, and this list exists to be scanned. Anything with room for the
 * side-by-side session layout starts roomy — the same test `desk` makes, since
 * a landscape phone is wide enough to fool a width-only check.
 */
const DENSITY_KEY = "vk.hub.compact";

function initialCompact(): boolean {
  const stored = localStorage.getItem(DENSITY_KEY);
  if (stored !== null) return stored === "1";
  return !matchMedia("(min-width: 800px) and (min-height: 540px)").matches;
}

function Band({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  if (count === 0) return null;
  return (
    <section className="mb-6">
      <div className="mb-2.5 flex items-center gap-2.5">
        <h2 className="text-[15px] font-semibold tracking-[-.02em]">{title}</h2>
        <span className="rounded-full bg-surface-2 px-2 text-[12px] font-semibold text-faint">
          {count}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
      {children}
    </section>
  );
}

export default function Hub() {
  const navigate = useNavigate();
  const { data: projects, loading, refresh } = usePoll<Project[]>("/api/projects");
  const { data: facts } = usePoll<PodFacts>("/api/facts", 30_000);
  const { data: usage } = usePoll<UsageSummary>("/api/usage", 60_000);
  const [adding, setAdding] = useState(false);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(initialCompact);

  // The hub sorts by what a session wants from you rather than by which repo it
  // belongs to, so it reads the flat feed and lets the project be a label on the
  // row. /api/projects is still needed below, for the repos with no session.
  const { data: sessions } = usePoll<Session[]>("/api/sessions");
  const needsYou = sessions?.filter((s) => s.status === "waiting") ?? [];
  const live = sessions?.filter((s) => s.status === "running") ?? [];
  // Capped: the tail of finished sessions is the inbox's job, not the hub's.
  // Sorted by when they ended, not by when they started, which is what the feed
  // arrives in — a long session begun on Monday can finish after a short one
  // begun on Tuesday, and under "recently finished" that read as scrambled.
  const finished = (sessions?.filter((s) => s.status === "done") ?? [])
    .slice()
    .sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt))
    .slice(0, 6);
  const running = live.length;
  const waiting = needsYou.length;

  // Polled rather than socketed: the strip only needs to be roughly current,
  // and the hub already polls two other things. Only the status is read now —
  // the strip explains what the assistant is instead of quoting it.
  const { data: assistant } = usePoll<AssistantThread>("/api/assistant", 10_000);
  // Only for the chair's face: who else is on the council is settings' business.
  const { data: council } = usePoll<CouncilMember[]>("/api/council", 120_000);
  const chair = (council ?? []).find((m) => m.chair);

  /**
   * One live fact on the door, instead of a paragraph explaining what is behind
   * it. The last thing asked and when it was answered is what tells you
   * whether to go back in; the explanation is on the empty screen inside.
   */
  function lastWord(t: AssistantThread | null | undefined): string | null {
    if (!t?.entries.length) return null;
    const asked = t.entries.find((e) => e.role === "user" && e.text.trim())?.text ?? "";
    const line = asked.split("\n")[0];
    const title = line.length > 60 ? `${line.slice(0, 59)}…` : line;
    const replies = t.entries.filter((e) => e.role === "assistant" && e.text.trim()).length;
    return `${agoLabel(t.entries[t.entries.length - 1].at)} · ${title || "(image)"}${
      replies > 1 ? ` · ${replies} replies` : ""
    }`;
  }
  const assistantLast = lastWord(assistant);

  async function addProject() {
    const value = input.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      const body = value.includes("/")
        ? { mode: "clone", url: value }
        : { mode: "init", name: value };
      const { name } = await api<{ name: string }>("/api/projects", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setAdding(false);
      setInput("");
      refresh();
      void navigate(`/p/${name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-[1140px] px-[18px] pt-[22px] pb-[60px]">
        {/* Above the projects, because it is not one. One door: whoever ends
            up answering, this is where you ask. */}
        <div className="mb-5">
          <Link
            to="/ai"
            // Flat tint rather than the gradient that was here: northlight rules
            // gradients out, and the tint is the same treatment its featured card
            // gets, which is what this strip is.
            className="flex items-start gap-3 rounded-xl border border-accent/40 bg-accent-tint px-[15px] py-3.5 hover:border-accent/70"
          >
            {/* The chair's own face: this is who answers. */}
            <Portrait
              face={chair?.face ?? "raccoon"}
              colour={chair?.colour ?? "amber"}
              mood={assistant?.status === "thinking" ? "speaking" : "idle"}
              size={36}
            />
            <span className="min-w-0 flex-1">
              <span className="mb-0.5 flex items-center gap-2">
                <span className="text-[14.5px] font-semibold tracking-[-.02em]">Assistant</span>
                {assistant?.status === "thinking" && (
                  <span className="flex items-center gap-1.5 text-[12px] text-accent">
                    <i className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                    {/* Who is working, when it is not the one you asked. A meeting
                      takes longer than a turn, and "working" alone reads as
                      stuck when it is three advisors thinking at once. */}
                    {assistant.speaking?.length
                      ? `${assistant.speaking.length} answering`
                      : "working"}
                  </span>
                )}
              </span>
              <span className="block truncate text-[12.5px] text-faint">
                {assistantLast ?? "Ask what needs you, or tell it something to remember."}
              </span>
            </span>
            <span className="flex-none pt-1 text-[13px] text-faint">→</span>
          </Link>
        </div>

        {/* Stacked on a phone: the headline is a sentence that wraps to two
            lines there, and a button held at its right edge ends up floating
            beside the wrap. */}
        <div className="mb-5 flex flex-col items-start gap-3 min-[480px]:flex-row min-[480px]:items-end min-[480px]:justify-between min-[480px]:gap-4">
          <div>
            {/* "All quiet" is a claim, and until the feed lands it is one this
                screen cannot make — it read as an answer on every open, a beat
                before the waiting sessions appeared underneath it. Same reason
                the projects grid below gets skeletons rather than an empty
                grid. */}
            <h1 className="mb-1 text-[22px] font-bold tracking-[-.03em]">
              {sessions === null
                ? "…"
                : waiting > 0
                  ? `${waiting} thing${waiting === 1 ? "" : "s"} waiting on you`
                  : running > 0
                    ? `${running} session${running === 1 ? "" : "s"} running`
                    : "All quiet"}
            </h1>
            <div className="text-sm text-muted">
              {waiting > 0 && running > 0
                ? `${running} other${running === 1 ? "" : "s"} still working`
                : `${projects?.length ?? 0} repo${projects?.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <div className="flex flex-none items-center gap-2">
            <button
              onClick={() => {
                const next = !compact;
                setCompact(next);
                localStorage.setItem(DENSITY_KEY, next ? "1" : "0");
              }}
              aria-pressed={compact}
              title={compact ? "roomier session rows" : "one line per session"}
              className={`tap flex-none rounded-lg border px-3.5 py-2 text-[13.5px] font-semibold hover:border-line-strong ${
                compact ? "border-accent/50 text-accent" : "border-line bg-surface text-muted"
              }`}
            >
              compact
            </button>
            <button
              onClick={() => setAdding(true)}
              className="tap flex-none rounded-lg border border-line bg-surface px-3.5 py-2 text-[13.5px] font-semibold hover:border-line-strong"
            >
              + add project
            </button>
          </div>
        </div>

        {sessions === null && (
          <div aria-hidden className="mb-6 grid gap-2">
            {[0, 1].map((i) => (
              <div
                key={i}
                className={`animate-pulse rounded-xl border border-line bg-surface ${
                  compact ? "h-[38px]" : "h-[86px]"
                }`}
              />
            ))}
          </div>
        )}

        {/* Full width and single column: this is the band you came for, and a
            grid would let it share a row with something that can wait. */}
        <Band title="Needs a decision" count={needsYou.length}>
          <div className="grid gap-2">
            {needsYou.map((s) => (
              <SessionCard key={s.id} session={s} urgent compact={compact} />
            ))}
          </div>
        </Band>

        {/* The quiet bands go multi-column instead, so a wide screen stops being
            one very long column of things that need nothing. A compact row is
            four things on one line, so it needs a wider column than a card
            whose fields are stacked. */}
        <Band title="Running" count={live.length}>
          <div className={`grid gap-2 ${compact ? COLS_COMPACT : COLS_ROOMY}`}>
            {live.map((s) => (
              <SessionCard key={s.id} session={s} compact={compact} />
            ))}
          </div>
        </Band>

        <Band title="Recently finished" count={finished.length}>
          <div className={`grid gap-2 ${compact ? COLS_COMPACT : COLS_ROOMY}`}>
            {finished.map((s) => (
              <SessionCard key={s.id} session={s} compact={compact} />
            ))}
          </div>
        </Band>

        <div className="mb-2.5 flex items-center gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-[-.02em]">Projects</h2>
          <span className="rounded-full bg-surface-2 px-2 text-[12px] font-semibold text-faint">
            {projects?.length ?? 0}
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>

        {/* Skeletons rather than an empty grid: "nothing here" and "not loaded
            yet" looked identical, so the hub flashed empty on every open. */}
        {loading && projects === null && (
          <div
            aria-hidden
            className="grid grid-cols-[repeat(auto-fill,minmax(min(290px,100%),1fr))] gap-3"
          >
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-[104px] animate-pulse rounded-xl border border-line bg-surface"
              />
            ))}
          </div>
        )}

        {projects?.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center font-mono text-[12.5px] text-faint">
            no projects yet — clone or init one above
          </div>
        )}

        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(290px,100%),1fr))] gap-3">
          {(projects ?? []).map((p) => (
            // A real link, not a button + navigate(): cmd-click, middle-click
            // and "open in new tab" all worked nowhere before this.
            <Link
              key={p.name}
              to={`/p/${p.name}`}
              className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4 text-left transition hover:-translate-y-px hover:border-accent-pastel"
            >
              <div className="flex items-center gap-2.5">
                <StatusDot running={p.running + p.waiting > 0} />
                <span className="min-w-0 truncate text-[15px] font-semibold tracking-[-.02em]">
                  {p.worktreeOf ? (
                    <>
                      <span className="text-muted">{p.worktreeOf}</span>
                      <span className="text-faint"> ⎇ </span>
                      {p.name.slice(p.worktreeOf.length + 2)}
                    </>
                  ) : (
                    p.name
                  )}
                </span>
                <span className="ml-auto">
                  {p.waiting > 0 ? (
                    <StatusChip kind="wait" label={`${p.waiting} waiting`} />
                  ) : p.running > 0 ? (
                    <StatusChip kind="run" label={`${p.running} running`} />
                  ) : (
                    <StatusChip kind="idle" label="idle" />
                  )}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 font-mono text-[11px] text-faint">
                <span className="min-w-0 truncate">
                  ⎇ {p.branch}
                  {p.dirty ? "*" : ""}
                </span>
                {p.agents.map((a) => (
                  <AgentTag key={a} agent={a} />
                ))}
                {p.running + p.waiting === 0 && (
                  <span>last session {agoLabel(p.lastSessionAt)}</span>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Was one wrapping run of mono text, which on a narrow window broke
            into five ragged lines and read as terminal output that happened to
            be pinned to the page. Disk and memory are ratios, so they get a
            meter and say so; the rest are counts. */}
        <div className="mt-10 rounded-xl border border-line bg-surface p-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 min-[560px]:grid-cols-4">
            <Stat label="Projects" value={String(projects?.length ?? 0)} />
            <Stat label="Running" value={String(running)} />
            {facts && (
              <Stat
                label="Data"
                value={`${gb(facts.diskTotal - facts.diskFree)} / ${gb(facts.diskTotal)}`}
                fraction={
                  facts.diskTotal > 0 ? (facts.diskTotal - facts.diskFree) / facts.diskTotal : null
                }
              />
            )}
            {facts && (
              <Stat
                label="Memory"
                value={
                  facts.memTotal > 0
                    ? `${gb(facts.memUsed)} / ${gb(facts.memTotal)}`
                    : gb(facts.memUsed)
                }
                // memTotal is 0 when the pod has no limit set, and a meter with
                // no ceiling is a bar that means nothing.
                fraction={facts.memTotal > 0 ? facts.memUsed / facts.memTotal : null}
              />
            )}
          </div>
          {/* Tokens are not a bill — every session runs on the subscription —
              but they are the share of its allowance the bench took, and the
              maintainer's share of that is the number that decides whether a
              third repo can join. Cached prompt tokens are counted: the plan
              meters them too, just cheaper. */}
          <UsagePanel usage={usage ?? null} />
          {facts && (facts.browsers > 0 || facts.docker) && (
            <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-[12px] text-faint">
              {facts.browsers > 0 && (
                <span>
                  {facts.browsers} headless browser{facts.browsers === 1 ? "" : "s"}
                </span>
              )}
              {facts.docker?.map((d) => (
                <span key={d.type}>
                  docker {d.type.toLowerCase()}{" "}
                  <span className="font-mono tabular-nums">{d.size}</span>
                  {d.reclaimable.startsWith("0B")
                    ? ""
                    : ` · ${d.reclaimable.split(" ")[0]} reclaimable`}
                </span>
              ))}
            </div>
          )}
        </div>
      </main>

      {adding && (
        <Sheet
          title="Add project"
          sub="Paste a GitHub repo (owner/repo or https URL) to clone, or a plain name to init a local repo."
          onClose={() => setAdding(false)}
        >
          <input
            ref={focusIfPointerFine}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addProject()}
            placeholder="owner/repo or project-name"
            className="w-full rounded-[11px] border border-line bg-surface-2 px-3.5 py-3 font-mono text-[14px] outline-none placeholder:text-faint focus:border-accent"
          />
          {error && <div className="mt-2 font-mono text-[12px] text-wait">{error}</div>}
          <button
            onClick={addProject}
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-accent px-3.5 py-2.5 font-mono text-[13px] font-semibold text-on-accent hover:brightness-110 disabled:opacity-50"
          >
            {busy ? "working…" : input.includes("/") ? "clone" : "init"}
          </button>
        </Sheet>
      )}
    </>
  );
}
