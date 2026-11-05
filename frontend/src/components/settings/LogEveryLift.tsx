import { useState } from "react";
import { useSearchParams } from "react-router";
import type { LogEveryLiftStatus } from "../../../../shared/api";
import { api, usePoll } from "../../api";
import { useConfirm } from "../../useConfirm";
import SectionLabel from "../SectionLabel";
import { StatusChip } from "../StatusChip";
import { buttonClass } from "../ui/Button";
import Notice from "../ui/Notice";

/**
 * LogEveryLift, signed in to once so the assistant can read training. The button
 * is a plain link: it leaves for LogEveryLift's consent page and comes back to
 * this tab with the outcome in the query.
 */
export default function LogEveryLift() {
  const { data, refresh } = usePoll<LogEveryLiftStatus>("/api/connectors/logeverylift", 60_000);
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [confirm, confirmDialog] = useConfirm();
  const outcome = params.get("logeverylift");
  const failed = params.get("logeverylift_error");

  async function disconnect() {
    const ok = await confirm({
      title: "Disconnect LogEveryLift?",
      body: "The pod forgets its sign-in, and the assistant stops reading your training until you sign in again.",
      action: "disconnect",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    try {
      await api("/api/connectors/logeverylift/disconnect", { method: "POST" });
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <SectionLabel icon="key" className="mt-2">
        LogEveryLift
      </SectionLabel>
      <div className="mb-3 text-sm text-muted">
        What the assistant reads when you ask about your training: workouts, records and programs.
        It reads only; a change goes through a card you tap.
      </div>

      {outcome === "ok" && data?.connected && (
        <div className="mb-3 rounded-[11px] bg-run/10 px-3 py-2 text-[13px] text-run ring-1 ring-run/30">
          Signed in.
        </div>
      )}
      {failed && (
        <div className="mb-3 rounded-[11px] bg-wait/10 px-3 py-2 text-[13px] text-wait ring-1 ring-wait/30">
          Sign-in did not finish: {failed}
        </div>
      )}
      {error && (
        <Notice kind="fail" className="mb-3">
          {error}
        </Notice>
      )}
      {data?.connected && data.error && (
        <Notice kind="fail" className="mb-3">
          LogEveryLift no longer accepts the stored sign-in ({data.error}). The assistant cannot
          read your training until you sign in again.
        </Notice>
      )}

      {data?.connected ? (
        <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
          {data.error ? (
            <StatusChip kind="fail" label="sign-in refused" />
          ) : (
            <StatusChip kind="run" label="connected" />
          )}
          <span className="min-w-0 flex-1" />
          <a
            href="/api/connectors/logeverylift/start"
            className="tap text-[12.5px] text-muted hover:text-text"
          >
            sign in again
          </a>
          <button
            onClick={() => void disconnect()}
            className="tap text-[12.5px] text-muted hover:text-fail"
          >
            disconnect
          </button>
        </div>
      ) : (
        <a href="/api/connectors/logeverylift/start" className={buttonClass("primary")}>
          Sign in to LogEveryLift
        </a>
      )}
      {confirmDialog}
    </>
  );
}
