import { useEffect, useState } from "react";
import type { PushStatus, PushTestResult } from "../../../../shared/api";
import { api } from "../../api";
import { vapidKey } from "../../vapid";
import SectionLabel from "../SectionLabel";
import { StatusChip } from "../StatusChip";
import Button from "../ui/Button";

/**
 * Push notifications for this device — the pod telling a pocketed phone that a
 * session wants input, or has finished.
 *
 * iOS delivers web push only to an app installed on the Home Screen and served
 * over a secure origin, so most of the states below exist to explain why the
 * enable button isn't offered yet.
 */
export default function Notifications() {
  const [state, setState] = useState<"loading" | "unavailable" | "denied" | "off" | "on">(
    "loading",
  );
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setState("unavailable");
        return;
      }
      // getRegistration (not .ready, which never resolves without a worker):
      // in dev, and in a plain browser tab on iOS, there is none.
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        setState("unavailable");
        return;
      }
      if (Notification.permission === "denied") {
        setState("denied");
        return;
      }
      const sub = await reg.pushManager.getSubscription();
      setState(sub ? "on" : "off");
      // Told again, every time this panel is opened. The browser's half of the
      // subscription outlives the pod's: restore the volume from a backup and
      // the endpoint list goes back to whatever it held that night, while every
      // phone still believes it is subscribed and this panel still says "on".
      // Nothing says otherwise until a push that should have arrived does not.
      // Re-registering is idempotent — it is keyed on the endpoint.
      const { endpoint, keys } = sub?.toJSON() ?? {};
      if (endpoint && keys?.p256dh && keys.auth) {
        await api<PushStatus>("/api/push/subscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
        })
          .then((s) => setDevices(s.devices))
          .catch(() => undefined);
        return;
      }
      await api<PushStatus>("/api/push")
        .then((s) => setDevices(s.devices))
        .catch(() => undefined);
    })();
  }, []);

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setNote(null);
    try {
      await run();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const enable = () =>
    act(async () => {
      // iOS only grants permission from a user gesture — this click.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) {
        setState("unavailable");
        return;
      }
      const { publicKey } = await api<PushStatus>("/api/push");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(publicKey),
      });
      const { endpoint, keys } = sub.toJSON();
      if (!endpoint || !keys?.p256dh || !keys?.auth) throw new Error("incomplete subscription");
      const res = await api<PushStatus>("/api/push/subscribe", {
        method: "POST",
        body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
      });
      setDevices(res.devices);
      setState("on");
    });

  const disable = () =>
    act(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        const res = await api<PushStatus>("/api/push/unsubscribe", {
          method: "POST",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        });
        setDevices(res.devices);
        await sub.unsubscribe();
      }
      setState("off");
    });

  const test = () =>
    act(async () => {
      const res = await api<PushTestResult>("/api/push/test", { method: "POST" });
      setNote(
        res.failed
          ? `the push service refused it: ${res.error ?? "unknown error"}`
          : res.sent
            ? "sent — it should arrive in a moment"
            : "no subscribed devices to send to",
      );
    });

  return (
    <>
      <SectionLabel icon="bell" className="mt-10">
        Notifications
      </SectionLabel>
      <div className="flex flex-wrap items-center gap-2.5 rounded-[11px] border border-line bg-surface px-[15px] py-2.5">
        <span className="text-[13px]">this device</span>
        {state === "on" && <StatusChip kind="run" label="subscribed" />}
        {state === "off" && <StatusChip kind="idle" label="off" />}
        {state === "denied" && <StatusChip kind="wait" label="blocked" />}
        {state === "unavailable" && <StatusChip kind="idle" label="unavailable" />}
        {state === "on" && (
          <>
            <Button onClick={test} disabled={busy} className="ml-auto">
              send test
            </Button>
            <Button onClick={disable} disabled={busy} variant="ghost-danger">
              turn off
            </Button>
          </>
        )}
        {state === "off" && (
          <Button onClick={enable} disabled={busy} variant="primary" className="ml-auto">
            {busy ? "enabling…" : "enable"}
          </Button>
        )}
      </div>
      {note && <div className="mt-2.5 text-[12.5px] text-muted">{note}</div>}
      <div className="mt-5 text-[13px] text-muted">
        {state === "unavailable" ? (
          <>
            This browser can't receive push here. On iPhone, add verksted to the Home Screen (Share
            → Add to Home Screen) and open it from there — Safari tabs get no push. The app also has
            to be served over https.
          </>
        ) : state === "denied" ? (
          <>
            Notifications are blocked for this app. Re-allow them in iOS Settings → Notifications →
            verksted (or the browser's site settings), then reload.
          </>
        ) : (
          <>
            The pod pushes when a session starts waiting for input or finishes; tapping the
            notification opens that session. Each device subscribes separately — {devices}{" "}
            subscribed right now.
          </>
        )}
      </div>
    </>
  );
}
