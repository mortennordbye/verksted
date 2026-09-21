import type { ReactNode } from "react";
import Icon, { type IconName } from "./Icon";

/**
 * The top of a page, the same on every one.
 *
 * Today, the bench, the inbox and settings each drew their own: a date beside
 * a button, a status line with buttons under it, a mono label over a title, a
 * bare title. Moving between tabs read as moving between apps. One shape now:
 * the page's name small with its icon, a headline saying the state of things,
 * one line under it, the page's own buttons on the right, and a rule below.
 */
export default function PageHeader({
  icon,
  label,
  title,
  sub,
  actions,
}: {
  icon: IconName;
  /** The page's name, which is also the tab it is under. */
  label: string;
  /** What is true of the page right now: "All quiet", the date, a count. */
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    // Stacked on a phone: the headline is a sentence that wraps there, and
    // buttons held at its right edge end up floating beside the wrap.
    <div className="mb-7 flex flex-col items-start gap-3 border-b border-line-strong pb-5 min-[560px]:flex-row min-[560px]:items-end min-[560px]:justify-between min-[560px]:gap-4">
      <div className="min-w-0">
        <div className="mb-2 flex items-center gap-1.5 caps">
          <Icon name={icon} size={13} />
          {label}
        </div>
        <h1 className="text-[22px] font-bold tracking-[-.03em]">{title}</h1>
        {sub && <div className="mt-1 text-sm text-muted">{sub}</div>}
      </div>
      {actions && <div className="flex flex-none flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
