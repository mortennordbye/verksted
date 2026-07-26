/// <reference lib="webworker" />
import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

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

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string } | null)?.url ?? "/";
  event.waitUntil(
    (async () => {
      // Reuse an open window when there is one — an installed PWA has exactly
      // one, and opening a second would lose whatever is on screen.
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const client = clients[0];
      if (client) {
        await client.focus();
        await client.navigate(url).catch(() => undefined);
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
