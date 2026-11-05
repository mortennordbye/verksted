import { useRef, type PointerEvent, type ReactNode } from "react";
import Icon from "./Icon";
import Overlay, { OverlayTitle, useOverlayDismiss } from "./ui/Overlay";

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
      <SheetBody title={title} sub={sub}>
        {children}
      </SheetBody>
    </Overlay>
  );
}

/** How far down a sheet has to be dragged, or how fast (px/ms), to let it go. */
const DRAG_CLOSE_PX = 80;
const DRAG_CLOSE_SPEED = 0.5;

/**
 * Inside the Overlay, for its dismiss: the way out is the animated one. On a
 * phone the top strip is a handle: drag it down and the sheet follows the
 * thumb, and past a threshold it goes. The whole strip rather than the pill,
 * because the pill is too small to aim at, and not the body, whose own scroll
 * would be fighting it.
 */
function SheetBody({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  const dismiss = useOverlayDismiss()!;
  const drag = useRef<{ y: number; t: number; dy: number } | null>(null);
  const boxOf = (el: Element) => el.closest<HTMLElement>('[role="dialog"]');

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest("button")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { y: e.clientY, t: e.timeStamp, dy: 0 };
    const box = boxOf(e.currentTarget);
    if (box) box.style.transition = "none";
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    // Down only: up is where the sheet already is.
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    const box = boxOf(e.currentTarget);
    if (box) box.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    const box = boxOf(e.currentTarget);
    if (!d || !box) return;
    const speed = d.dy / Math.max(1, e.timeStamp - d.t);
    if (d.dy > DRAG_CLOSE_PX || (d.dy > 10 && speed > DRAG_CLOSE_SPEED)) {
      dismiss();
    } else {
      box.style.transition = "transform 0.2s cubic-bezier(0.32, 0.72, 0, 1)";
      box.style.transform = "";
    }
  };

  return (
    <>
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        className="-mx-[18px] -mt-5 mb-1 touch-none px-[18px] pt-2 select-none"
      >
        <div
          aria-hidden
          className="mx-auto mb-3 h-1 w-9 rounded-full bg-line min-[800px]:invisible"
        />
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <OverlayTitle className="mb-0.5 text-[15px] font-semibold">{title}</OverlayTitle>
            <div className="mb-4 text-sm text-muted">{sub}</div>
          </div>
          <button
            onClick={dismiss}
            aria-label="close"
            className="tap-sq -mt-1.5 -mr-2 flex flex-none items-center justify-center text-faint hover:text-text"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
      {children}
      <button onClick={dismiss} className="tap mt-3 w-full p-[11px] text-[13.5px] text-muted">
        cancel
      </button>
    </>
  );
}
