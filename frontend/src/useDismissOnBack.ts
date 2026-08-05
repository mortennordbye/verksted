import { useEffect, useRef } from "react";

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

    // Marked so popstate can tell our own entry from a real navigation.
    history.pushState({ vkOverlay: true }, "");
    let popped = false;

    const onPop = () => {
      popped = true;
      close.current();
    };
    addEventListener("popstate", onPop);

    return () => {
      removeEventListener("popstate", onPop);
      // Closed by something other than Back: drop the entry we added, or it
      // would swallow the next Back press.
      if (!popped && (history.state as { vkOverlay?: boolean } | null)?.vkOverlay) {
        history.back();
      }
    };
  }, [open]);
}
