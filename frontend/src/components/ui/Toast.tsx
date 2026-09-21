import { Toast } from "radix-ui";
import { useSyncExternalStore } from "react";

interface Item {
  id: number;
  message: string;
  action?: { label: string; run: () => void };
  duration: number;
  /** A toast with the same key replaces the one before it. */
  key?: string;
}

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const publish = (next: Item[]) => {
  items = next;
  for (const l of listeners) l();
};

/**
 * Say something that is over in a moment: copied, saved, done and here is the
 * way back.
 *
 * There was no pattern for it. Each button that copied or saved swapped its own
 * label for two seconds, which a screen reader never heard, and the inbox's
 * undo sat in the flow of the list where it scrolled out of sight. One region,
 * mounted once in App, announced politely and floated above the phone's tab bar.
 */
export function toast(
  message: string,
  {
    action,
    duration = 3_000,
    key,
  }: { action?: Item["action"]; duration?: number; key?: string } = {},
): void {
  const item = { id: nextId++, message, action, duration, key };
  publish([...items.filter((t) => key === undefined || t.key !== key), item]);
}

/**
 * "Done, and here is the way back", for a tap that is cheap to make by mistake.
 * Offered for as long as it is plausibly still the thing you just did, and only
 * for the last thing: a second offer replaces the first.
 */
export function offerUndo(label: string, revert: () => Promise<void> | void): void {
  toast(label, {
    key: "undo",
    duration: 15_000,
    action: { label: "undo", run: () => void revert() },
  });
}

/** Clears every toast. For tests, which share this module between cases. */
export function resetToasts(): void {
  publish([]);
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function Toaster() {
  const shown = useSyncExternalStore(subscribe, () => items);
  const drop = (id: number) => publish(items.filter((t) => t.id !== id));

  return (
    <Toast.Provider swipeDirection="down">
      {shown.map((t) => (
        <Toast.Root
          key={t.id}
          duration={t.duration}
          onOpenChange={(open) => !open && drop(t.id)}
          className="pointer-events-auto flex w-full items-center gap-2.5 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] shadow-[0_6px_20px_rgba(0,0,0,.35)]"
        >
          <Toast.Description className="min-w-0 flex-1 text-muted">{t.message}</Toast.Description>
          {t.action && (
            <Toast.Action
              altText={`${t.action.label}: ${t.message}`}
              onClick={t.action.run}
              className="tap flex-none rounded-[7px] border border-line px-2.5 py-1 text-[12px] text-muted hover:border-line-strong hover:text-text"
            >
              {t.action.label}
            </Toast.Action>
          )}
        </Toast.Root>
      ))}
      <Toast.Viewport className="fixed inset-x-0 bottom-[max(16px,env(safe-area-inset-bottom))] z-50 mx-auto flex w-full max-w-[440px] flex-col gap-2 px-4 outline-none over-tabs:bottom-[calc(63px+env(safe-area-inset-bottom))]" />
    </Toast.Provider>
  );
}
