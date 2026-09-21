import { useRegisterSW } from "virtual:pwa-register/react";
import Button from "./ui/Button";
import Icon from "./Icon";

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

  // Above the phone tab bar where there is one: it used to cover it, so the
  // app told you it had a new build by taking away the way around it.
  if (!needRefresh) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 flex items-center gap-3 border-t border-line bg-surface px-[18px] py-2.5 pb-[max(10px,env(safe-area-inset-bottom))] text-[13px] text-muted over-tabs:bottom-[calc(55px+env(safe-area-inset-bottom))] over-tabs:pb-2.5">
      <span className="min-w-0 flex-1">a new build of verksted is ready</span>
      <Button
        onClick={() => void updateServiceWorker(true)}
        variant="primary"
        className="flex-none"
      >
        reload
      </Button>
      <button
        onClick={() => setNeedRefresh(false)}
        aria-label="dismiss"
        className="tap-sq flex flex-none items-center justify-center px-1 text-faint hover:text-text"
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
