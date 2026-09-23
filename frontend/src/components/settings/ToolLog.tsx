import { useState } from "react";
import type { ToolLogDay, ToolLogEntry } from "../../../../shared/api";
import { api, usePoll } from "../../api";
import { useConfirm } from "../../useConfirm";
import SectionLabel from "../SectionLabel";
import { SkeletonList } from "../Skeleton";
import { StatusChip } from "../StatusChip";
import Button from "../ui/Button";
import Notice from "../ui/Notice";
import { toast } from "../ui/Toast";

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

function Row({ entry, onUndo }: { entry: ToolLogEntry; onUndo: () => void }) {
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
          {entry.undo === "done" && <StatusChip kind="idle" label="put back" />}
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
      {entry.undo === "can" && (
        <Button size="xs" onClick={onUndo} className="mt-1.5">
          put back
        </Button>
      )}
    </li>
  );
}

/**
 * What the assistant changed, one day at a time (A-31).
 *
 * Every call that changed something is logged with its arguments in full, and
 * until this the only way to read it was a shell on the pod. A move, a
 * relabel and a calendar change can be put back from their row; what is put
 * back is what the server recorded that call doing, never what the row says.
 */
export default function ToolLog() {
  const [day, setDay] = useState<string | null>(null);
  const { data, error, refresh } = usePoll<ToolLogDay>(
    `/api/assistant/tool-log${day ? `?day=${day}` : ""}`,
    60_000,
  );
  const [confirm, dialog] = useConfirm();
  const [undoError, setUndoError] = useState<string | null>(null);

  async function undo(entry: ToolLogEntry) {
    if (!data?.day) return;
    const ok = await confirm({
      title: `Put back this ${entry.tool}?`,
      body: "What the call changed is changed back: mail moved back, labels put back, the event as it was before.",
      action: "put back",
    });
    if (!ok) return;
    setUndoError(null);
    try {
      const { said } = await api<{ said: string }>("/api/assistant/tool-log/undo", {
        method: "POST",
        body: JSON.stringify({ day: data.day, at: entry.at }),
      });
      toast(said);
      refresh();
    } catch (e) {
      setUndoError((e as Error).message);
    }
  }
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
      {(error ?? undoError) && (
        <Notice kind="fail" className="mb-3">
          {error ?? undoError}
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
              <Row key={`${e.at}-${i}`} entry={e} onUndo={() => void undo(e)} />
            ))}
          </ul>
        </>
      )}
      {dialog}
    </>
  );
}
