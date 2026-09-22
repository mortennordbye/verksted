import { useState } from "react";
import type { ToolLogDay, ToolLogEntry } from "../../../../shared/api";
import { usePoll } from "../../api";
import SectionLabel from "../SectionLabel";
import { SkeletonList } from "../Skeleton";
import { StatusChip } from "../StatusChip";
import Button from "../ui/Button";
import Notice from "../ui/Notice";

function dayLabel(day: string): string {
  // Noon, so no timezone moves the date to the day before.
  return new Date(`${day}T12:00:00`).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

function timeLabel(at: string): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Row({ entry }: { entry: ToolLogEntry }) {
  const args = JSON.stringify(entry.args);
  return (
    <li className="border-b border-line py-2 last:border-b-0">
      <details>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
          <span className="font-mono text-[11.5px] text-faint">{timeLabel(entry.at)}</span>
          <span className="font-mono">{entry.tool}</span>
          <span className="text-muted">{entry.speaker}</span>
          {entry.unattended && <StatusChip kind="wait" label="unattended" />}
          {!entry.ok && <StatusChip kind="fail" label="failed" />}
          <span className="min-w-0 basis-full truncate font-mono text-[11.5px] text-faint">
            {args}
          </span>
        </summary>
        <pre className="mt-2 font-mono text-[11.5px] break-all whitespace-pre-wrap text-muted">
          {JSON.stringify(entry.args, null, 2)}
        </pre>
        {entry.result && (
          <div className="mt-1.5 text-[12.5px] break-words text-muted">{entry.result}</div>
        )}
      </details>
    </li>
  );
}

/**
 * What the assistant changed, one day at a time (A-31).
 *
 * Every call that changed something is logged with its arguments in full, and
 * until this the only way to read it was a shell on the pod. Read-only: what
 * can be put back, and how, is a per-tool question this does not answer.
 */
export default function ToolLog() {
  const [day, setDay] = useState<string | null>(null);
  const { data, error } = usePoll<ToolLogDay>(
    `/api/assistant/tool-log${day ? `?day=${day}` : ""}`,
    60_000,
  );
  const shown = data?.day ?? null;
  const at = shown ? (data?.days.indexOf(shown) ?? -1) : -1;
  const newer = at > 0 ? data?.days[at - 1] : undefined;
  const older = at >= 0 ? data?.days[at + 1] : undefined;

  return (
    <>
      <SectionLabel icon="history" className="mt-10">
        What it changed
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        Every call the assistant made that changed something, with what it was given and what came
        back. Reads are not listed. Kept for 90 days.
      </div>
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}
      {!data ? (
        <SkeletonList count={3} className="h-10 rounded-lg bg-surface" />
      ) : !shown ? (
        <div className="text-[13px] text-faint">Nothing yet.</div>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <Button
              size="xs"
              onClick={() => older && setDay(older)}
              disabled={!older}
              aria-label="an earlier day"
            >
              ‹
            </Button>
            <span className="text-[13px] font-semibold">{dayLabel(shown)}</span>
            <Button
              size="xs"
              onClick={() => newer && setDay(newer)}
              disabled={!newer}
              aria-label="a later day"
            >
              ›
            </Button>
            <span className="ml-auto text-[11.5px] text-faint">
              {data.entries.length} call{data.entries.length === 1 ? "" : "s"}
            </span>
          </div>
          <ul>
            {[...data.entries].reverse().map((e, i) => (
              <Row key={`${e.at}-${i}`} entry={e} />
            ))}
          </ul>
        </>
      )}
    </>
  );
}
