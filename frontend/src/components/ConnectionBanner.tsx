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

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 top-0 z-50 flex items-center gap-2 border-b border-fail/40 bg-fail/15 px-[18px] py-2 pt-[max(8px,env(safe-area-inset-top))] font-mono text-[12px] text-text backdrop-blur"
    >
      <span aria-hidden className="inline-block size-1.5 flex-none animate-pulse rounded-full bg-fail" />
      <span className="min-w-0 flex-1">can't reach the pod — showing the last data, still retrying</span>
    </div>
  );
}
