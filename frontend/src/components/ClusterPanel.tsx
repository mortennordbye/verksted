import { useState } from "react";
import type { ClusterSnapshot } from "../../../shared/api";
import { usePoll } from "../api";
import { StatusChip } from "./StatusChip";

/**
 * The cluster this pod runs in, on the bench beside the pod's own facts.
 *
 * /api/cluster has always been there and only the assistant ever read it, so
 * "did the promotion land" was a question you had to ask in prose and read
 * back as a paraphrase. This is the table itself.
 *
 * Every section is a `kubectl get` table and stays one (see ClusterSnapshot):
 * nothing here parses columns. A row is counted, not read, and the table opens
 * under its own heading when you want the columns.
 */

/** The two sections whose rows are, by construction, things to look at. */
const ATTENTION = new Set(["UNHEALTHY PODS", "RECENT WARNINGS"]);

/** A kubectl table's rows, minus its header. A placeholder has none. */
function rowCount(text: string): number | null {
  if (text.startsWith("(")) return null;
  return Math.max(0, text.split("\n").length - 1);
}

function Section({ title, text }: { title: string; text: string }) {
  const rows = rowCount(text);
  const wants = ATTENTION.has(title) && rows !== null && rows > 0;
  const [open, setOpen] = useState(wants);

  return (
    <div className="border-t border-line first:border-t-0">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="tap flex w-full items-center gap-2.5 py-2 text-left"
      >
        <span className="flex-none text-[11px] text-faint">{open ? "▾" : "▸"}</span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[.08em] text-faint uppercase">
          {title}
        </span>
        {rows === null ? (
          // "(all pods healthy)", "(none)", "(unreadable)" — the backend's own
          // words, which say more than a count of nothing would.
          <StatusChip
            kind={text === "(unreadable)" ? "idle" : "run"}
            label={text.replace(/[()]/g, "")}
          />
        ) : (
          <StatusChip
            kind={wants ? "wait" : "idle"}
            label={`${rows} ${rows === 1 ? "row" : "rows"}`}
          />
        )}
      </button>
      {open && rows !== null && (
        // These tables are wider than a phone and there is no shortening them
        // without dropping the columns Argo CD and Kargo chose to print, so
        // they scroll sideways inside their own box rather than the page.
        <pre className="mb-2 overflow-x-auto rounded-md border border-line bg-term p-2.5 font-mono text-[11.5px] leading-relaxed text-muted">
          {text}
        </pre>
      )}
    </div>
  );
}

export default function ClusterPanel() {
  const { data } = usePoll<ClusterSnapshot>("/api/cluster", 30_000);

  // A laptop has no cluster credential, and an empty card saying so on every
  // bench that is not the pod would be noise rather than news.
  if (!data?.reachable) return null;

  return (
    <section
      aria-label="cluster"
      className="mt-4 rounded-xl border border-line bg-surface px-4 py-2 min-[560px]:px-4"
    >
      {data.sections.map((s) => (
        <Section key={s.title} title={s.title} text={s.text} />
      ))}
    </section>
  );
}
