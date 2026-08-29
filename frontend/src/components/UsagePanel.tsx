import type { PlanSample, SessionUsage, UsageSummary } from "../../../shared/api";
import { StatusChip } from "./StatusChip";

/**
 * What the bench costs, on the hub.
 *
 * Nothing here is a bill: every session runs on the subscription. What it
 * shows is the share of that subscription's allowance the bench took — the
 * plan's own windows first, since those are what run out — then the tokens
 * behind them: how many, what kind (most are cached re-reads, which the plan
 * meters cheaply), which days, which repos, and how the sessions went. The
 * dollar figures are what the same tokens would have cost at API list prices,
 * there for the fun of knowing.
 *
 * Colour is data ink only: the four chart tokens in theme.css, assigned by
 * role in a fixed order, and the status colours for the plan meters and the
 * outcome chips. Text stays in text tokens.
 */

/** Tokens as a short figure: 41k, 1.2M. */
export function tokens(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n);
}

/** Notional dollars: $0.42, $18, $1,204. */
export function usd(n: number): string {
  return n >= 100
    ? `$${Math.round(n).toLocaleString()}`
    : n >= 10
      ? `$${n.toFixed(1)}`
      : `$${n.toFixed(2)}`;
}

/** Every bucket a session was charged for, added up. */
function total(t: SessionUsage): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** When a plan window rolls over, in this device's clock: "16:59" or "Wed 20:59". */
function resetLabel(iso: string | null): string {
  if (!iso) return "";
  const at = new Date(iso);
  const sameDay = at.toDateString() === new Date().toDateString();
  return at.toLocaleString([], {
    ...(sameDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 text-[11px] font-semibold tracking-[.08em] text-faint uppercase">
      {children}
    </div>
  );
}

/**
 * A plan window as a meter. Status colours, since that is what it is: green
 * while there is room, amber past three quarters, red past nine tenths — the
 * point at which the day's sessions start queuing behind the night's.
 */
function PlanMeter({
  label,
  percent,
  resetsAt,
}: {
  label: string;
  percent: number;
  resetsAt: string | null;
}) {
  const pct = Math.min(100, Math.max(0, percent));
  const tone = pct >= 90 ? "bg-fail" : pct >= 75 ? "bg-wait" : "bg-accent";
  return (
    <div className="min-w-0">
      <Label>{label}</Label>
      <div className="flex items-baseline gap-2">
        <span className="text-[15px] font-semibold tabular-nums">{pct}%</span>
        <span className="truncate text-[11px] text-faint">
          used{resetsAt ? ` · resets ${resetLabel(resetsAt)}` : ""}
        </span>
      </div>
      <div
        className="mt-2 h-[5px] overflow-hidden rounded-full bg-surface-2"
        role="img"
        aria-label={`${pct}% of the ${label} used`}
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** Series order is fixed: what a person drove, then what ran on its own. */
const DAY_SERIES = [
  { key: "interactive", label: "interactive", cls: "bg-chart-1" },
  { key: "unattended", label: "unattended", cls: "bg-chart-2" },
] as const;

/** One bar of a row: a period, its tokens, and the unattended share. */
interface Bar {
  key: string;
  total: number;
  unattended: number;
  costUsd: number;
}

/**
 * A row of stacked bars, scaled to the row's peak. Every period is drawn, so
 * a quiet one reads as quiet rather than missing; a native tooltip carries the
 * exact figures. Days and months both come through here.
 */
function Bars({ items, unit }: { items: Bar[]; unit: string }) {
  const peak = Math.max(1, ...items.map((d) => d.total));
  return (
    <div>
      <div
        className="flex h-12 items-end gap-[2px]"
        role="img"
        aria-label={`tokens per ${unit} over ${items.length} ${unit}s, peak ${tokens(peak)}`}
      >
        {items.map((d) => {
          const interactive = d.total - d.unattended;
          const h = (n: number) => `${(n / peak) * 100}%`;
          return (
            <div
              key={d.key}
              title={`${d.key}: ${tokens(d.total)}${d.unattended ? ` (${tokens(d.unattended)} unattended)` : ""} · ${usd(d.costUsd)}`}
              className="flex h-full flex-1 flex-col justify-end gap-[1px]"
            >
              {d.unattended > 0 && (
                <div className="rounded-t-[2px] bg-chart-2" style={{ height: h(d.unattended) }} />
              )}
              <div
                className={`bg-chart-1 ${d.unattended > 0 ? "" : "rounded-t-[2px]"} ${d.total === 0 ? "min-h-[2px] opacity-30" : ""}`}
                style={{ height: h(interactive) }}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-faint tabular-nums">
        <span>{items[0]?.key}</span>
        <span className="flex gap-3">
          {DAY_SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className={`inline-block h-2 w-2 rounded-[2px] ${s.cls}`} />
              {s.label}
            </span>
          ))}
        </span>
        <span>{items.at(-1)?.key}</span>
      </div>
    </div>
  );
}

/** Series order is fixed here too: the five-hour window, then the week. */
const PLAN_SERIES = [
  { key: "session", label: "5-hour window", stroke: "var(--color-chart-1)" },
  { key: "week", label: "week", stroke: "var(--color-chart-2)" },
] as const;

/**
 * How full the plan was, hour by hour over the last week: two lines on one
 * axis, both in percent. A column per sample carries the hover figures.
 */
function PlanHistory({ history }: { history: PlanSample[] }) {
  const W = 600;
  const H = 60;
  const first = Date.parse(history[0].at);
  const span = Math.max(1, Date.parse(history[history.length - 1].at) - first);
  const x = (s: PlanSample) => ((Date.parse(s.at) - first) / span) * W;
  const y = (pct: number) => H - (Math.min(100, Math.max(0, pct)) / 100) * H;
  const points = (key: "session" | "week") => history.map((s) => `${x(s)},${y(s[key])}`).join(" ");
  const col = W / Math.max(1, history.length - 1);
  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-14 w-full"
        role="img"
        aria-label={`plan usage over ${history.length} hourly samples`}
      >
        {[25, 50, 75].map((g) => (
          <line
            key={g}
            x1={0}
            x2={W}
            y1={y(g)}
            y2={y(g)}
            stroke="var(--color-line)"
            strokeWidth={1}
          />
        ))}
        <line
          x1={0}
          x2={W}
          y1={y(100)}
          y2={y(100)}
          stroke="var(--color-fail)"
          strokeWidth={1}
          strokeDasharray="4 4"
        />
        {PLAN_SERIES.map((s) => (
          <polyline
            key={s.key}
            points={points(s.key)}
            fill="none"
            stroke={s.stroke}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeLinejoin="round"
          />
        ))}
        {history.map((s) => (
          <rect key={s.at} x={x(s) - col / 2} y={0} width={col} height={H} fill="transparent">
            <title>
              {`${new Date(s.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}: 5-hour window ${s.session}%, week ${s.week}%`}
            </title>
          </rect>
        ))}
      </svg>
      <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 text-[11px] text-faint tabular-nums">
        <span>{new Date(history[0].at).toLocaleDateString([], { weekday: "short" })}</span>
        <span className="flex gap-3">
          {PLAN_SERIES.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-[2px]"
                style={{ background: s.stroke }}
              />
              {s.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-[2px] w-3 bg-fail" />
            full
          </span>
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

/** Buckets in a fixed order, so the same kind is always the same colour. */
const MIX = [
  { key: "input", label: "input", cls: "bg-chart-1" },
  { key: "cacheWrite", label: "cache writes", cls: "bg-chart-2" },
  { key: "cacheRead", label: "cache reads", cls: "bg-chart-3" },
  { key: "output", label: "output", cls: "bg-chart-4" },
] as const;

/** The month's tokens by kind, as one bar. Most of it is cache reads. */
function MixBar({ t }: { t: SessionUsage }) {
  const sum = Math.max(1, total(t));
  const share = (n: number) => (n / sum) * 100;
  return (
    <div>
      <div
        className="flex h-2 gap-[2px] overflow-hidden rounded-full"
        role="img"
        aria-label={MIX.map((m) => `${m.label} ${share(t[m.key]).toFixed(1)}%`).join(", ")}
      >
        {MIX.map((m) =>
          t[m.key] > 0 ? (
            <div
              key={m.key}
              title={`${m.label}: ${tokens(t[m.key])} (${share(t[m.key]).toFixed(1)}%)`}
              className={`${m.cls} min-w-[2px]`}
              style={{ width: `${share(t[m.key])}%` }}
            />
          ) : null,
        )}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-faint tabular-nums">
        {MIX.map((m) => (
          <span key={m.key} className="flex items-center gap-1.5">
            <span className={`inline-block h-2 w-2 rounded-[2px] ${m.cls}`} />
            {m.label} {tokens(t[m.key])} · {share(t[m.key]).toFixed(1)}%
          </span>
        ))}
      </div>
    </div>
  );
}

/** The month by repo: one hue, the bar says how much, the text says exactly. */
function ProjectBars({ projects }: { projects: UsageSummary["projects"] }) {
  const peak = Math.max(1, ...projects.map((p) => p.total));
  return (
    <div className="flex flex-col gap-1.5">
      {projects.map((p) => (
        <div
          key={p.project}
          className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-3"
        >
          <span className="truncate font-mono text-[12px]">{p.project}</span>
          <div className="h-[6px] overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-chart-1"
              style={{ width: `${(p.total / peak) * 100}%` }}
            />
          </div>
          <span className="text-[11px] text-faint tabular-nums">
            <span className="font-mono">{tokens(p.total)}</span> · {p.sessions} session
            {p.sessions === 1 ? "" : "s"} · {usd(p.costUsd)}
          </span>
        </div>
      ))}
    </div>
  );
}

const OUTCOMES: {
  key: keyof UsageSummary["outcomes"];
  kind: "run" | "wait" | "fail" | "idle";
  label: string;
}[] = [
  { key: "ok", kind: "run", label: "ok" },
  { key: "attention", kind: "wait", label: "needed a look" },
  { key: "failed", kind: "fail", label: "failed" },
  { key: "done", kind: "idle", label: "done, no sign-off" },
];

export default function UsagePanel({ usage }: { usage: UsageSummary | null }) {
  if (!usage) return null;
  const month = usage.windows.find((w) => w.days === 30) ?? usage.windows.at(-1);
  const any = usage.windows.some((w) => w.sessions > 0);
  if (!usage.plan && !any) return null;
  const monthTotal = month ? total(month.tokens) : 0;
  const prompt = month ? month.tokens.input + month.tokens.cacheRead + month.tokens.cacheWrite : 0;
  const cacheRate = prompt > 0 && month ? (month.tokens.cacheRead / prompt) * 100 : null;
  const outcomeTotal = Object.values(usage.outcomes).reduce((n, v) => n + v, 0);

  return (
    <>
      {usage.plan && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4">
            <PlanMeter
              label="Plan · 5-hour window"
              percent={usage.plan.session.percent}
              resetsAt={usage.plan.session.resetsAt}
            />
            <PlanMeter
              label="Plan · this week"
              percent={usage.plan.week.percent}
              resetsAt={usage.plan.week.resetsAt}
            />
          </div>
          {usage.plan.history.length >= 2 && (
            <div className="mt-3">
              <Label>How full the plan was · last 7 days</Label>
              <PlanHistory history={usage.plan.history} />
            </div>
          )}
          {usage.plan.models.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-faint">
              {usage.plan.models.map((m) => (
                <span key={m.model}>
                  {m.model} this week <span className="font-mono tabular-nums">{m.percent}%</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {any && month && (
        <div className="mt-4 border-t border-line pt-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-4 min-[560px]:grid-cols-3 min-[880px]:grid-cols-5">
            {usage.windows.map((w) => (
              <div key={w.days} className="min-w-0">
                <Label>Tokens · {w.label}</Label>
                <div className="truncate text-[15px] font-semibold tabular-nums">
                  {tokens(total(w.tokens))}
                </div>
                <div className="mt-0.5 truncate text-[11px] text-faint tabular-nums">
                  {w.days === 0 && usage.months[0] ? `since ${usage.months[0].month} · ` : ""}
                  {w.sessions} session{w.sessions === 1 ? "" : "s"}
                  {w.unattended > 0 && ` · ${tokens(w.unattended)} unattended`}
                  {` · ${usd(w.costUsd)}`}
                </div>
              </div>
            ))}
            <div className="min-w-0">
              <Label>Cache hit rate · 30 days</Label>
              <div className="truncate text-[15px] font-semibold tabular-nums">
                {cacheRate == null ? "–" : `${cacheRate.toFixed(0)}%`}
              </div>
              <div className="mt-0.5 truncate text-[11px] text-faint tabular-nums">
                {month.tokens.turns.toLocaleString()} API calls
                {month.sessions > 0 && ` · ${tokens(monthTotal / month.sessions)} per session`}
              </div>
            </div>
          </div>

          <div className="mt-4">
            <Label>Tokens per day · 30 days</Label>
            <Bars items={usage.days.map((d) => ({ ...d, key: d.date }))} unit="day" />
          </div>

          {usage.months.length > 1 && (
            <div className="mt-4">
              <Label>Tokens per month · all time</Label>
              <Bars items={usage.months.map((m) => ({ ...m, key: m.month }))} unit="month" />
            </div>
          )}

          <div className="mt-4">
            <Label>What kind · 30 days</Label>
            <MixBar t={month.tokens} />
          </div>

          {usage.projects.length > 0 && (
            <div className="mt-4">
              <Label>By project · 30 days</Label>
              <ProjectBars projects={usage.projects} />
            </div>
          )}

          {outcomeTotal > 0 && (
            <div className="mt-4">
              <Label>How the sessions went · 30 days</Label>
              <div className="flex flex-wrap items-center gap-2">
                {OUTCOMES.filter((o) => usage.outcomes[o.key] > 0).map((o) => (
                  <StatusChip
                    key={o.key}
                    kind={o.kind}
                    label={`${usage.outcomes[o.key]} ${o.label}`}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mt-3 text-[11px] text-faint">
            Dollar figures are what the same tokens would cost at API list prices. Nothing here is
            billed: every session runs on the subscription, and the plan meters above are what it
            actually draws on.
          </div>
        </div>
      )}
    </>
  );
}
