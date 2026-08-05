import { useEffect, type ReactNode } from "react";
import { useOverlayDismiss } from "../useDismissOnBack";

/**
 * Autofocus, but only where focusing is free.
 *
 * `autoFocus` on a field inside a sheet summons the on-screen keyboard the
 * moment the sheet opens, which shoves the sheet up and often off the top of a
 * phone screen before it has been read. On a desktop the focus is the whole
 * point, so it is kept there. Use as `ref={focusIfPointerFine}`.
 */
export function focusIfPointerFine(el: HTMLInputElement | HTMLTextAreaElement | null): void {
  if (el && matchMedia("(pointer: fine)").matches) el.focus();
}

export default function Sheet({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: ReactNode;
}) {
  // A Sheet is only ever rendered when it is open, so Escape and Back close
  // this one rather than leaving the screen.
  useOverlayDismiss(true, onClose);

  // Scroll lock. Without it a touch drag over the sheet scrolls the page
  // underneath, which on a phone reads as the sheet sliding around.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div
      // Presentational: the backdrop is a click-away shortcut, not a control.
      // Every way out it offers already exists on the keyboard — Escape and
      // Android Back through useDismissOnBack, and the cancel button below —
      // so there is nothing here for a keyboard user to be locked out of.
      role="presentation"
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 min-[800px]:items-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        // dvh and an inner scroll: a landscape phone is ~400px tall, and a
        // sheet with a few fields used to run past the bottom of the screen,
        // taking its confirm button with it.
        className="flex max-h-[90dvh] w-full max-w-[520px] flex-col overflow-y-auto overscroll-contain rounded-t-2xl border border-line bg-surface px-[18px] pt-5 pr-[max(18px,env(safe-area-inset-right))] pb-[calc(20px+env(safe-area-inset-bottom))] pl-[max(18px,env(safe-area-inset-left))] min-[800px]:rounded-2xl"
      >
        <h2 className="mb-0.5 text-[15px] font-semibold">{title}</h2>
        <div className="mb-4 text-sm text-muted">{sub}</div>
        {children}
        <button
          onClick={onClose}
          className="tap mt-3 w-full p-[11px] font-mono text-[13px] text-muted"
        >
          cancel
        </button>
      </div>
    </div>
  );
}
