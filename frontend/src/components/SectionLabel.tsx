import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/**
 * The small mono label a settings section starts with, and the rule above it.
 *
 * The page is one long column of panels, and with only a word in caps and a
 * margin between them one panel's last field ran into the next panel's title.
 * A section gets a firmer line with room under it; a `sub` label inside a
 * section (a list's own heading) keeps the icon and drops the rule. Spacing
 * above stays the caller's, since each panel already sets its own.
 */
export default function SectionLabel({
  icon,
  sub = false,
  className = "",
  children,
}: {
  icon: IconName;
  sub?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`mb-2.5 flex items-center gap-1.5 font-mono text-[11px] tracking-[.12em] text-faint uppercase ${
        sub ? "" : "border-t border-line-strong pt-6"
      } ${className}`}
    >
      <Icon name={icon} size={13} />
      {children}
    </div>
  );
}
