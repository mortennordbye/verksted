import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/**
 * A section's heading: what it is at a glance, how many, and a rule to the
 * edge. The rule is the firmer line on purpose: on the page's own ground a
 * hairline let one band run into the next, and every section read as one list.
 * `action` sits at the far end of the rule, for the one control a section has
 * of its own (showing the quiet items, say).
 */
export default function BandHeading({
  icon,
  title,
  count,
  action,
}: {
  icon: IconName;
  title: string;
  count: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <Icon name={icon} size={16} className="text-muted" />
      <h2 className="text-[15.5px] font-semibold tracking-[-.02em]">{title}</h2>
      <span className="rounded-full bg-surface-2 px-2 text-[12px] font-semibold text-faint">
        {count}
      </span>
      <span className="h-px flex-1 bg-line-strong" />
      {action}
    </div>
  );
}
