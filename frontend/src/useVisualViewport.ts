import { useEffect } from "react";

/**
 * Publishes the visual viewport as `--vvh` (height) and `--vvt` (offset from the
 * layout viewport top). iOS Safari keeps `100dvh` — and the layout viewport —
 * at full height when the on-screen keyboard opens, so a terminal sized in dvh
 * puts the agent prompt underneath the keys. The visual viewport is the only
 * height that reflects the keyboard; sizing the screen to it (and never letting
 * the document scroll) keeps the prompt above the keyboard, and shrinking the
 * terminal box refits xterm, which resizes tmux to match.
 *
 * It also sets `data-kbd` on the root for the `kbd` variant in theme.css, which
 * is what the assistant's composer uses to drop onto the keys and hide the tab
 * bar it otherwise sits above.
 */
export function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
      // The keyboard, as a boolean, for the `kbd` variant in theme.css. The
      // layout viewport keeps its full height while the visual one shrinks, so
      // the gap is the keyboard — 150px clears the browser's own toolbars,
      // which are what account for the difference when no keyboard is up.
      root.dataset.kbd = innerHeight - vv.height > 150 ? "1" : "";
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
      delete root.dataset.kbd;
    };
  }, []);
}
