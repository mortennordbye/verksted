/**
 * Whether this device can get the pod's pushes, and whether it does.
 *
 * iOS delivers web push only to an app installed on the Home Screen, so in a
 * Safari tab, and in dev where there is no service worker, it is unavailable.
 * The settings panel acts on the answer; Today only shows it.
 */
export type PushState = "unavailable" | "denied" | "off" | "on";

export async function devicePush(): Promise<{ state: PushState; sub: PushSubscription | null }> {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { state: "unavailable", sub: null };
  }
  // getRegistration (not .ready, which never resolves without a worker):
  // in dev, and in a plain browser tab on iOS, there is none.
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return { state: "unavailable", sub: null };
  if (Notification.permission === "denied") return { state: "denied", sub: null };
  const sub = await reg.pushManager.getSubscription();
  return { state: sub ? "on" : "off", sub };
}
