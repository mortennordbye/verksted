import type { ReactNode } from "react";
import Overlay, { OverlayTitle } from "./ui/Overlay";

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
  return (
    // dvh and an inner scroll: a landscape phone is ~400px tall, and a sheet
    // with a few fields used to run past the bottom of the screen, taking its
    // confirm button with it.
    <Overlay
      label={title}
      onClose={onClose}
      placement="sheet"
      ownTitle
      className="max-h-[90dvh] w-full max-w-[520px] overflow-y-auto overscroll-contain rounded-t-2xl px-[18px] pt-5 pr-[max(18px,env(safe-area-inset-right))] pb-[calc(20px+env(safe-area-inset-bottom))] pl-[max(18px,env(safe-area-inset-left))] min-[800px]:rounded-2xl"
    >
      <OverlayTitle className="mb-0.5 text-[15px] font-semibold">{title}</OverlayTitle>
      <div className="mb-4 text-sm text-muted">{sub}</div>
      {children}
      <button onClick={onClose} className="tap mt-3 w-full p-[11px] text-[13.5px] text-muted">
        cancel
      </button>
    </Overlay>
  );
}
