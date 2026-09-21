import type { ReactNode } from "react";
import Icon from "../Icon";

/**
 * The kinds of thing a panel has to say about itself. fail is something that
 * did not happen; busy is something happening now; ok is something that just
 * did; note is a fact worth stopping on that is not a failure.
 */
const KIND = {
  fail: { box: "bg-fail/10 text-fail ring-fail/30", role: "alert" },
  busy: { box: "bg-accent-tint text-accent ring-accent/30", role: "status" },
  ok: { box: "bg-run/10 text-run ring-run/30", role: "status" },
  note: { box: "bg-wait/5 text-wait ring-wait/30", role: "status" },
} as const;

/**
 * A line of feedback inside a panel: what went wrong, what is under way, what
 * just happened.
 *
 * It had four shapes and two colours: a bare line in the waiting colour about
 * fifteen times, the same line in the failure colour in five others, a ringed
 * box once, and a banner that said it with `role="alert"` in one place only,
 * so a failed save was silent to a screen reader almost everywhere. This is
 * that one banner (BranchControl's), for every panel. A failure is announced
 * as an alert, the rest as a polite status.
 *
 * `small` is for the narrow side panels, where the text around it is 11px.
 */
export default function Notice({
  kind,
  small = false,
  onDismiss,
  className = "",
  children,
}: {
  kind: keyof typeof KIND;
  small?: boolean;
  /** For a notice that outlives the thing it is about, a way to put it away. */
  onDismiss?: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { box, role } = KIND[kind];
  return (
    <div
      role={role}
      className={`flex items-start gap-2 rounded-lg ring-1 ${box} ${
        small ? "px-2 py-1.5 text-[11.5px]" : "px-3 py-2 text-[13px]"
      } ${className}`}
    >
      {kind === "busy" ? (
        <span className="mt-[5px] inline-block h-2 w-2 flex-none rounded-full animate-pulse bg-accent" />
      ) : (
        <Icon
          name={kind === "ok" ? "check" : "alert"}
          size={small ? 12 : 14}
          className={small ? "mt-[1px]" : "mt-[2px]"}
        />
      )}
      <span className="min-w-0 flex-1 break-words">{children}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="dismiss"
          className="tap-sq -my-1.5 flex flex-none items-center justify-center px-1 opacity-70 hover:opacity-100"
        >
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  );
}
