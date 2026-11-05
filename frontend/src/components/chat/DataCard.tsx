import type { AssistantCard } from "../../../../shared/api";

const kr = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });
const kg = new Intl.NumberFormat("nb-NO", { maximumFractionDigits: 0 });

function month(key: string): string {
  const d = new Date(`${key}-01T00:00:00`);
  return Number.isNaN(d.getTime())
    ? key
    : d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function week(start: string): string {
  const d = new Date(`${start}T00:00:00`);
  return Number.isNaN(d.getTime())
    ? start
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** A figure: its value large, in text colour, and what it is beneath. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate font-mono text-[17px] font-semibold text-text">{value}</span>
      <span className="text-meta text-muted">{label}</span>
    </div>
  );
}

const HEIGHT = 88;

/**
 * Weekly volume as bars: one series, so no legend, the title names it. Each bar
 * says its week and figures on hover and to a screen reader, and the newest week is
 * labelled directly.
 */
function Volume({ weeks }: { weeks: { weekStart: string; volumeKg: number; sessions: number }[] }) {
  const max = Math.max(...weeks.map((w) => w.volumeKg), 1);
  const slot = 100 / weeks.length;
  const last = weeks.at(-1)!;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-semibold text-text">Training volume per week</span>
        <span className="font-mono text-meta text-muted">
          this week {kg.format(last.volumeKg)} kg · {last.sessions} sessions
        </span>
      </div>
      <svg
        role="img"
        aria-label={`Weekly volume over ${weeks.length} weeks`}
        viewBox={`0 0 100 ${HEIGHT}`}
        preserveAspectRatio="none"
        className="h-[88px] w-full"
      >
        <line
          x1="0"
          x2="100"
          y1={HEIGHT - 0.5}
          y2={HEIGHT - 0.5}
          className="stroke-line"
          strokeWidth="0.5"
          vectorEffect="non-scaling-stroke"
        />
        {weeks.map((w, i) => {
          const h = Math.max((w.volumeKg / max) * (HEIGHT - 4), w.volumeKg ? 2 : 0);
          return (
            <g key={w.weekStart} className="group/bar">
              <title>{`Week of ${week(w.weekStart)}: ${kg.format(w.volumeKg)} kg, ${w.sessions} sessions`}</title>
              {/* The whole slot answers to the pointer, not just the bar. */}
              <rect x={i * slot} y="0" width={slot} height={HEIGHT} fill="transparent" />
              <rect
                x={i * slot + slot * 0.15}
                y={HEIGHT - h}
                width={slot * 0.7}
                height={h}
                rx="1"
                className="fill-chart-1 transition-opacity group-hover/bar:opacity-80"
              />
            </g>
          );
        })}
      </svg>
      <div className="flex justify-between font-mono text-meta text-faint">
        <span>{week(weeks[0].weekStart)}</span>
        <span>{week(last.weekStart)}</span>
      </div>
    </>
  );
}

/** A tool's result as a picture, under the chips of the reply that used it. */
export default function DataCard({ card }: { card: AssistantCard }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5">
      {card.kind === "budget" ? (
        <>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px] font-semibold text-text">Budget, {month(card.month)}</span>
            {card.rate && <span className="text-meta text-muted">savings: {card.rate}</span>}
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Stat label="net income" value={`${kr.format(card.income)} kr`} />
            <Stat label="fixed costs" value={`${kr.format(card.fixed)} kr`} />
            <Stat label="saved" value={`${kr.format(card.saved)} kr`} />
          </div>
        </>
      ) : (
        <Volume weeks={card.weeks} />
      )}
    </div>
  );
}
