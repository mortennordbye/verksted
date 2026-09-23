import { useEffect, useRef, useState, type ReactNode } from "react";
import { useDismissOnBack } from "../../useDismissOnBack";
import BrowserPane from "../BrowserPane";
import Icon from "../Icon";

/** The media query the `desk` variant stands for: where the panel is a half, not the screen. */
export const DESK = "(min-width: 800px) and (min-height: 540px)";

export const dockBtn =
  "tap-hit flex-none rounded-lg bg-surface px-2.5 py-1 font-medium text-muted hover:bg-surface-2 hover:text-text";

/**
 * A panel beside the conversation rather than over it: the chair's browser, or
 * the calendar it writes to.
 *
 * Both are for watching what it does while reading what it says, so on a
 * desktop the panel takes the right half and the thread moves into the left.
 * A phone has no second half to give, so there it is the whole screen.
 * Fullscreen on a desktop is for when the panel is what is being read.
 *
 * Where it covers the thread (a phone, or fullscreen) it is a dialog: Back
 * closes it rather than leaving the screen, focus moves into it and comes back
 * after, and the page under it is inert (C-17). Escape closes it only where
 * `escape` is set. The browser relays keys into the remote page, and an Escape
 * meant for a dialog over there would take the whole panel away here.
 */
export default function Dock({
  title,
  sub,
  onClose,
  escape = false,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  escape?: boolean;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const ref = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const covers = full || !matchMedia(DESK).matches;
  useDismissOnBack(true, onClose);

  useEffect(() => {
    if (!escape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [escape, onClose]);

  // Into the panel on the way in, and back to whatever opened it on the way out.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => opener?.focus?.({ preventScroll: true });
  }, []);

  // What it covers is out of reach while it does: no tabbing into a thread
  // that cannot be seen.
  useEffect(() => {
    const el = ref.current;
    if (!covers || !el?.parentElement) return;
    const others = [...el.parentElement.children].filter(
      (c): c is HTMLElement => c !== el && c instanceof HTMLElement && !c.inert,
    );
    for (const c of others) c.inert = true;
    return () => {
      for (const c of others) c.inert = false;
    };
  }, [covers]);

  return (
    <aside
      ref={ref}
      role="dialog"
      aria-modal={covers}
      aria-label={title}
      className={`fixed inset-0 z-50 flex flex-col bg-bg ${
        full ? "" : "desk:left-1/2 desk:z-30 desk:border-l desk:border-line"
      }`}
    >
      <div className="flex flex-none items-center gap-2 border-b border-line px-3 pt-[max(8px,env(safe-area-inset-top),var(--banner-h,0px))] pb-2 text-[12px]">
        <span className="flex-none font-semibold">{title}</span>
        <span className="min-w-0 flex-1 truncate text-faint">{sub}</span>
        <button
          onClick={() => setFull((f) => !f)}
          className={`${dockBtn} hidden items-center gap-1.5 desk:flex`}
        >
          <Icon name={full ? "shrink" : "expand"} size={14} />
          {full ? "exit fullscreen" : "fullscreen"}
        </button>
        <button ref={closeRef} onClick={onClose} className={`${dockBtn} flex items-center gap-1.5`}>
          <Icon name="close" size={14} />
          close
        </button>
      </div>
      {children}
    </aside>
  );
}

export function BrowserView() {
  const ref = useRef<HTMLDivElement | null>(null);
  // The document is what scrolls on this screen, so a wheel over the remote
  // page scrolled the thread behind it as well. The canvas still gets the
  // event; only the page's own default is cancelled. Native and non-passive,
  // since React's wheel listener is passive and cannot cancel anything.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hold = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", hold, { passive: false });
    return () => el.removeEventListener("wheel", hold);
  }, []);
  return (
    <div ref={ref} className="flex min-h-0 flex-1 flex-col">
      <BrowserPane wsPath="/api/assistant/browser" />
    </div>
  );
}
