import { useMemo, useState, type KeyboardEvent } from "react";

export interface MenuItem {
  /** What the field becomes, or what is run, when this is picked. */
  value: string;
  label: string;
  hint: string;
}

/** What is being typed at the start of the field, if it can be completed. */
export function matchingItems(text: string, items: MenuItem[]): MenuItem[] {
  if (!/^[@/][a-z0-9-]*$/i.test(text)) return [];
  const typed = text.toLowerCase();
  return items.filter((i) => i.label.toLowerCase().startsWith(typed));
}

/**
 * The keys the menu takes for itself while it is open, and which item is lit.
 *
 * Not cmdk, which the command palette uses: that expects to own its input, and this
 * follows a textarea that has to go on being the composer.
 */
export function useComposerMenu(
  text: string,
  items: MenuItem[],
  onPick: (item: MenuItem) => void,
): {
  shown: MenuItem[];
  active: number;
  onKey: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
} {
  const [dismissed, setDismissed] = useState<string | null>(null);
  // Kept with the text it was chosen for, so typing another letter starts again.
  const [moved, setMoved] = useState({ text, index: 0 });
  const active = moved.text === text ? moved.index : 0;
  const matches = useMemo(() => matchingItems(text, items), [text, items]);
  const shown = dismissed === text ? [] : matches;

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!shown.length) return false;
    if (e.key === "ArrowDown") setMoved({ text, index: (active + 1) % shown.length });
    else if (e.key === "ArrowUp") {
      setMoved({ text, index: (active - 1 + shown.length) % shown.length });
    } else if (e.key === "Escape") setDismissed(text);
    else if (e.key === "Enter" || e.key === "Tab") {
      const item = shown[active];
      if (item) onPick(item);
    } else return false;
    e.preventDefault();
    return true;
  };

  return { shown, active, onKey };
}

export default function ComposerMenu({
  items,
  active,
  onPick,
}: {
  items: MenuItem[];
  active: number;
  onPick: (item: MenuItem) => void;
}) {
  if (!items.length) return null;
  return (
    <div
      role="listbox"
      aria-label="complete what you are typing"
      className="absolute inset-x-[18px] bottom-full z-20 mb-1 flex max-h-64 flex-col overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-lg motion-safe:animate-pop-in"
    >
      {items.map((item, i) => (
        <button
          key={item.value}
          type="button"
          role="option"
          aria-selected={i === active}
          // Before the field loses focus, so picking does not close the keyboard.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPick(item)}
          className={`tap flex items-baseline gap-2.5 rounded-lg px-2.5 py-1.5 text-left ${
            i === active ? "bg-surface-2" : "hover:bg-surface-2"
          }`}
        >
          <span className="flex-none font-mono text-[12.5px] text-text">{item.label}</span>
          <span className="min-w-0 truncate text-[12.5px] text-muted">{item.hint}</span>
        </button>
      ))}
    </div>
  );
}
