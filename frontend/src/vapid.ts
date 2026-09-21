/**
 * VAPID keys travel as base64url; PushManager wants the raw bytes.
 *
 * Shared by the settings panel, which subscribes when you switch pushes on,
 * and by the worker, which has to subscribe again on its own when the browser
 * retires an endpoint.
 */
export function vapidKey(b64: string): Uint8Array<ArrayBuffer> {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
