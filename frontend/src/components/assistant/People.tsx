import { Link } from "react-router";
import type { CouncilMember } from "../../../../shared/api";
import Portrait, { MEMBER_TEXT } from "../Face";
import Icon from "../Icon";
import { SkeletonList } from "../Skeleton";

/**
 * Who sits on the bench beside the chair, as people rather than a settings
 * form: what each is for, and a way to ask one directly.
 *
 * Read-only here. The chair still decides who answers; "ask" only writes the
 * `@id` the server reads, the same as typing the name. Editing stays on the
 * settings page, one link away.
 */
export default function People({
  members,
  onAsk,
  roundTable,
  onRoundTable,
}: {
  members: CouncilMember[];
  onAsk: (id: string) => void;
  roundTable: boolean;
  onRoundTable: (on: boolean) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-3 pt-3 pb-[max(12px,env(safe-area-inset-bottom))]">
      {/* The one say you have in who answers without naming anyone: hear two or
          three of them talk it over, one after another, rather than the chair
          deciding alone whether to bring anybody in. */}
      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
        <input
          type="checkbox"
          checked={roundTable}
          onChange={(e) => onRoundTable(e.target.checked)}
          className="mt-1 accent-accent"
        />
        <span className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold">Round table</span>
          <span className="text-[12.5px] leading-snug text-muted">
            What you send next is talked over by the specialists, each hearing the one before.
            Slower and dearer than one answer; stays on until you turn it off.
          </span>
        </span>
      </label>
      {members.length === 0 && (
        <SkeletonList count={3} className="h-[64px] rounded-xl border border-line bg-surface" />
      )}
      {members.map((m) => (
        <div
          key={m.id}
          className={`flex items-start gap-3 rounded-xl border border-line bg-surface px-3 py-2.5 ${
            m.enabled ? "" : "opacity-55"
          }`}
        >
          <Portrait face={m.face} colour={m.colour} size={36} tone mood="idle" />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className={`text-[14px] font-semibold ${MEMBER_TEXT[m.colour]}`}>{m.name}</span>
              <span className="font-mono text-[11px] text-faint">
                {m.chair ? "chair" : `@${m.id}`}
              </span>
              {!m.enabled && <span className="text-[11.5px] text-faint">off</span>}
            </div>
            <span className="text-[13px] leading-snug text-muted">{m.remit}</span>
            <span className="font-mono text-[11px] text-faint">
              {m.model} · {m.effort}
            </span>
          </div>
          {!m.chair && m.enabled && (
            <button
              onClick={() => onAsk(m.id)}
              title={`ask ${m.name} directly`}
              className="tap-hit flex flex-none items-center gap-1.5 self-center rounded-lg bg-surface-2 px-2.5 py-1 text-[12px] font-medium text-muted hover:text-text"
            >
              <Icon name="chat" size={13} />
              ask
            </button>
          )}
        </div>
      ))}
      <Link
        to="/settings#council"
        className="mt-1 flex items-center gap-1.5 px-1 text-[12.5px] text-faint hover:text-text"
      >
        <Icon name="users" size={13} />
        edit specialists in settings
      </Link>
    </div>
  );
}
