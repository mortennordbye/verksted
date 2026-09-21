import { ToggleGroup } from "radix-ui";
import type { ReactNode } from "react";

const SIZE = {
  md: "tap rounded-lg px-3 py-1.5 text-[12.5px]",
  // `tap-hit`, not `tap`: the session's strip sits in a narrow column, where a
  // 44px box per tab would take half of it. The hit area is 44px all the same.
  sm: "tap-hit rounded-md px-2.5 py-1 text-[11.5px]",
} as const;

/**
 * A strip of mutually exclusive views: the settings sections, a project's
 * tabs, a session's side panel.
 *
 * Three strips were built separately, with different tap classes and no
 * keyboard story beyond Tab through every one. On Radix's single ToggleGroup
 * they are one tab stop with arrow keys between them, and a screen reader hears
 * them as what they are: one choice out of a set (a radio in a group), not
 * ARIA tabs with panels of their own to point at.
 *
 * Choosing the one already on does nothing, rather than turning it off.
 */
export default function SegTabs<T extends string>({
  label,
  value,
  onChange,
  items,
  size = "md",
  className = "",
}: {
  label: string;
  value: T;
  onChange: (next: T) => void;
  items: readonly { value: T; content: ReactNode }[];
  size?: keyof typeof SIZE;
  className?: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      aria-label={label}
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      className={className}
    >
      {items.map((item) => (
        <ToggleGroup.Item
          key={item.value}
          value={item.value}
          className={`flex flex-none items-center gap-1.5 border ${SIZE[size]} ${
            item.value === value
              ? "border-accent bg-surface-2 text-text"
              : "border-line bg-surface text-muted hover:text-text"
          }`}
        >
          {item.content}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
