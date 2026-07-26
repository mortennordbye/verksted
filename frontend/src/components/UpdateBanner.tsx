import { useRegisterSW } from "virtual:pwa-register/react";

/** How often an open app asks whether a newer build has been deployed. */
const CHECK_MS = 60_000;

/**
 * Offers the reload that swaps in a new build. An installed PWA can stay open
 * for days without a navigation, so it is also what asks the pod for updates
 * at all — without the poll below, a phone on the home screen keeps serving
 * the service worker's cached build indefinitely.
 */
export default function UpdateBanner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, reg) {
      if (!reg) return;
      const check = () => {
        if (!document.hidden) void reg.update();
      };
      setInterval(check, CHECK_MS);
      document.addEventListener("visibilitychange", check);
    },
  });

  if (!needRefresh) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t border-line bg-surface px-[18px] py-2.5 pb-[max(10px,env(safe-area-inset-bottom))] font-mono text-[12.5px] text-muted">
      <span className="min-w-0 flex-1">a new build of verksted is ready</span>
      <button
        onClick={() => void updateServiceWorker(true)}
        className="flex-none rounded-[7px] bg-accent px-2.5 py-1.5 text-[12px] font-semibold text-[#16130a] hover:brightness-110"
      >
        reload
      </button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="dismiss"
        className="flex-none px-1 text-faint hover:text-text"
      >
        ✕
      </button>
    </div>
  );
}
