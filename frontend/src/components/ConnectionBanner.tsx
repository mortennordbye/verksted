import { useLayoutEffect, useRef } from "react";
import { useOnline } from "../connection";

/**
 * Says out loud that the app is looking at stale data.
 *
 * Every screen polls and every screen kept its last good answer on failure, so
 * a dead pod or a dropped WireGuard tunnel looked exactly like an idle agent:
 * the terminal still showed its last frame and the status badges froze
 * mid-truth. On a phone that is the difference between "nothing needs me" and
 * "I have not been connected for an hour".
 *
 * The polls keep running underneath, so this clears itself the moment anything
 * gets an answer — there is no retry button because there is nothing to press.
 */
export default function ConnectionBanner() {
  const online = useOnline();
  if (online) return null;
  return <Banner />;
}

function Banner() {
  const ref = useRef<HTMLDivElement>(null);

  /**
   * How tall this is, published as `--banner-h` for every top bar to pad to.
   *
   * It is fixed over the top of the screen, which is where the back arrow is,
   * so while the pod was unreachable — exactly when you want to leave a screen
   * that has stopped updating — the way out was underneath it. Measured
   * rather than assumed, because the sentence wraps to two lines on a phone
   * and one on a desk, and the safe-area inset is part of it.
   */
  useLayoutEffect(() => {
    const el = ref.current!;
    const root = document.documentElement.style;
    const publish = () => root.setProperty("--banner-h", `${el.offsetHeight}px`);
    publish();
    const ro = new ResizeObserver(publish);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.removeProperty("--banner-h");
    };
  }, []);

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex transform-gpu items-center gap-2 border-b border-fail/40 bg-fail/15 px-[18px] py-2 pt-[max(8px,env(safe-area-inset-top))] text-[12.5px] text-text backdrop-blur"
    >
      <span
        aria-hidden
        className="inline-block size-1.5 flex-none animate-pulse rounded-full bg-fail"
      />
      <span className="min-w-0 flex-1">
        can't reach the pod — showing the last data, still retrying
      </span>
    </div>
  );
}
