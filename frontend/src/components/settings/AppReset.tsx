import { useState } from "react";
import { useConfirm } from "../../useConfirm";
import SectionLabel from "../SectionLabel";
import Button from "../ui/Button";

/**
 * The way out when the installed PWA is stuck on an old build: drops the
 * service worker and every cache it holds, then reloads from the pod.
 */
export default function AppReset() {
  const [busy, setBusy] = useState(false);
  const [confirm, confirmDialog] = useConfirm();

  async function hardReset() {
    if (busy) return;
    const ok = await confirm({
      title: "Hard reset the app?",
      body: "The cached app shell is deleted and the page reloads from the pod. Sessions, repos and settings are untouched.",
      action: "reset the app",
    });
    if (!ok) return;
    setBusy(true);
    for (const reg of (await navigator.serviceWorker?.getRegistrations()) ?? []) {
      await reg.unregister();
    }
    if ("caches" in window) {
      await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    }
    location.reload();
  }

  return (
    <>
      <SectionLabel icon="bench" className="mt-10">
        App
      </SectionLabel>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">hard reset</span>
        <Button onClick={hardReset} disabled={busy} variant="ghost-danger" className="ml-auto">
          {busy ? "resetting…" : "clear cache and reload"}
        </Button>
      </div>
      <div className="mt-5 text-[13px] text-muted">
        New builds normally announce themselves with a reload banner. Use this when the home-screen
        app is serving something stale anyway — it unregisters the service worker, deletes its
        caches and reloads from the pod.
      </div>
      {confirmDialog}
    </>
  );
}
