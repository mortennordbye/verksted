import { useEffect, useRef } from "react";

/**
 * How many overlays are open. The history entry is shared between them: the
 * first to open pushes it, the last to close pops it, and one that opens as
 * another closes — the session's actions sheet handing over to its confirm —
 * inherits the entry rather than pushing a second one.
 *
 * That handover is why this is module state and not per-overlay.
 * `history.back()` does not pop synchronously; the popstate it produces arrives
 * a task later, by which time the replacement overlay has mounted and
 * registered its own listener. The confirm then saw a Back nobody pressed and
 * closed itself, resolving "no" — so killing or deleting a session from its own
 * screen silently did nothing, in production as well as in dev, where
 * StrictMode's remount produced the same collision on the first overlay opened.
 */
let openOverlays = 0;

/** True while the current history entry is the one an overlay pushed. */
function overlayEntry(): boolean {
  return (history.state as { vkOverlay?: boolean } | null)?.vkOverlay === true;
}

/**
 * Make Android's hardware Back close an overlay instead of leaving the screen.
 *
 * Sheets, modals and the fullscreen terminal are all state, not routes, so Back
 * used to skip straight past them — out of the session entirely, dropping the
 * terminal websocket on the way. Pushing a history entry while the overlay is
 * open makes Back pop that entry instead, which is what the gesture means
 * everywhere else on the platform.
 *
 * Closing the overlay any other way (the cancel button, Escape, the backdrop)
 * removes the entry again, so Back does not have to be pressed twice
 * afterwards to leave the screen.
 */
export function useDismissOnBack(open: boolean, onClose: () => void): void {
  // Kept in a ref so a caller passing an inline arrow does not re-run the
  // effect on every render, which would push a new entry each time.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;

    openOverlays++;
    // Marked so popstate can tell our own entry from a real navigation.
    if (openOverlays === 1 && !overlayEntry()) history.pushState({ vkOverlay: true }, "");

    // Two overlays genuinely open at once share the entry, so Back closes both.
    // They stack only by accident in this app, and one press leaving one of
    // them behind is the worse of the two answers.
    const onPop = () => close.current();
    addEventListener("popstate", onPop);

    return () => {
      removeEventListener("popstate", onPop);
      openOverlays--;
      // Deferred to a task, not a microtask: an overlay closing in order to
      // open another is one tick, not two, and the replacement has to have
      // mounted before this decides the last one is gone. A microtask is not
      // late enough — React flushes those between the unmount and the mount.
      // Back itself needs nothing here: the browser has popped the entry
      // already, which is what the check below sees.
      setTimeout(() => {
        if (openOverlays === 0 && overlayEntry()) history.back();
      }, 0);
    };
  }, [open]);
}

/**
 * The two ways out every overlay in this app offers: Escape on a desktop, and
 * Android Back on a phone. Sheet, the code viewer and the session's file viewer
 * each had their own copy of the keydown effect next to their own call to
 * useDismissOnBack; the file viewer had neither, which is how it ended up
 * closeable only by pointer.
 *
 * `open` matters for overlays that are rendered unconditionally and hidden by
 * state. One that is only mounted while open passes true.
 */
export function useOverlayDismiss(open: boolean, onClose: () => void): void {
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);

  useDismissOnBack(open, onClose);
}
