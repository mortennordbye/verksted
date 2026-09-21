/// <reference lib="webworker" />
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { ExpirationPlugin } from "workbox-expiration";
import { appPath } from "./app-path";
import { vapidKey } from "./vapid";

// The app's service worker. It does what the generated one did — precache the
// built assets, fall back to the SPA shell for navigations — plus the one thing
// only a hand-written worker can: receive push notifications while the app is
// closed, which on iOS is the only way a phone hears that an agent is waiting.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: (string | { url: string; revision: string | null })[];
};

precacheAndRoute(self.__WB_MANIFEST);

// Navigations serve the cached shell; /api (REST and websockets) never does.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("index.html"), { denylist: [/^\/api\//] }),
);

/**
 * The file-type icons, kept as they are used.
 *
 * They are 1,226 files and the precache deliberately skips them: fetching every
 * icon for every language the theme knows, on install, over the tunnel, to draw
 * the dozen a repo actually contains. Cache-first because the name carries a
 * content hash — a given URL is one image for ever — and the dozen a repo does
 * use are then offline and free from the second visit.
 */
registerRoute(
  ({ url, request }) =>
    request.destination === "image" && url.pathname.startsWith("/assets/icons/"),
  new CacheFirst({
    cacheName: "file-icons",
    // Room for several repos' worth without keeping every icon a build ever
    // produced: a deploy changes the hashes, and the old entries are dead.
    plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 30 * 24 * 60 * 60 })],
  }),
);

// "prompt" updates: a new build waits here until the user taps reload in the
// banner, which posts this message. Auto-activating would yank the terminal out
// from under whoever is typing in it.
self.addEventListener("message", (event) => {
  if ((event.data as { type?: string } | null)?.type === "SKIP_WAITING") {
    void self.skipWaiting();
  }
});

interface PushPayload {
  title: string;
  body: string;
  url: string;
}

self.addEventListener("push", (event) => {
  let payload: PushPayload = { title: "verksted", body: "session update", url: "/" };
  try {
    payload = { ...payload, ...(event.data?.json() as Partial<PushPayload>) };
  } catch {
    // Not our JSON — keep the generic text rather than drop the notification.
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: payload.url },
      // One notification per session: a later update replaces the earlier one
      // instead of stacking "waiting" on top of "waiting".
      tag: payload.url,
    }),
  );
});

/**
 * The browser retired this device's endpoint and issued another.
 *
 * It happens on its own schedule — a long quiet spell, a browser update, a
 * push service rotating its keys — and nothing about it is visible: the
 * settings panel still reads "on", because a subscription still exists, and
 * the pod goes on posting to an endpoint that has been dead for a week. The
 * only sign is a phone that stopped buzzing.
 *
 * Subscribing again here is the whole recovery, and it needs no user gesture:
 * permission was granted for this origin and is not what changed.
 */
self.addEventListener("pushsubscriptionchange", ((event: ExtendableEvent) => {
  event.waitUntil(
    (async () => {
      const status = (await fetch("/api/push")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as { publicKey?: string } | null;
      if (!status?.publicKey) return;
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidKey(status.publicKey),
      });
      const { endpoint, keys } = sub.toJSON();
      if (!endpoint || !keys?.p256dh || !keys.auth) return;
      await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } }),
      });
    })(),
  );
}) as EventListener);

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = appPath(
    (event.notification.data as { url?: unknown } | null)?.url,
    self.location.origin,
  );
  event.waitUntil(
    (async () => {
      // Reuse an open window when there is one — an installed PWA has exactly
      // one, and opening a second would lose whatever is on screen.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = clients[0];
      if (client) {
        await client.focus();
        // A message, not `client.navigate`. Navigating is a full document load:
        // it drops the terminal's websocket, the event stream and whatever was
        // typed and unsent — and it did that even when the app was already on
        // the session the notification was about, which is the common case,
        // since the push that says an agent is waiting is the push you tap
        // while looking at it. The app routes itself from here.
        client.postMessage({ type: "navigate", url });
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
