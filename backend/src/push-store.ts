import fs from "node:fs/promises";
import webpush from "web-push";
import { env } from "./env.js";

/**
 * Web push for the installed PWA. iOS delivers these to the home-screen app,
 * which is the point: a phone in a pocket gets told the agent is waiting.
 *
 * The VAPID keypair is generated on first use and kept next to the
 * subscriptions on the data volume — nothing to configure, and the identity
 * survives restarts (regenerating it would silently break every subscription).
 */

/** A browser subscription, as PushSubscription.toJSON() serializes it. */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Which device this is, for the settings list. */
  label: string;
  addedAt: string;
}

interface PushFile {
  vapid: { publicKey: string; privateKey: string };
  subs: PushSub[];
}

interface Logger {
  warn: (obj: unknown, msg?: string) => void;
}

export interface PushPayload {
  title: string;
  body: string;
  /** App-relative path the notification opens. */
  url: string;
}

export interface SendResult {
  sent: number;
  failed: number;
  /** The push service's rejection, when at least one device failed. */
  error?: string;
}

/** One phone, one tablet, a laptop… a cap, not a design limit. */
const MAX_SUBS = 20;

// Push services want a contact for the sender, and Apple *validates* it: a
// mailto on a non-routable domain (localhost) gets every push rejected with
// 403 BadJwtToken. The deployment's own https URL is both routable and honest
// about who is sending; example.com is the fallback when the pod has no URL
// configured (or only a plain-http one, which RFC 8292 doesn't allow here).
const VAPID_SUBJECT = env.PUBLIC_URL.startsWith("https://")
  ? env.PUBLIC_URL
  : "mailto:verksted@example.com";

let cache: PushFile | null = null;

async function read(): Promise<PushFile> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(await fs.readFile(env.PUSH_FILE, "utf8")) as PushFile;
    if (parsed?.vapid?.publicKey && parsed?.vapid?.privateKey) {
      cache = { vapid: parsed.vapid, subs: parsed.subs ?? [] };
      return cache;
    }
  } catch {
    // No file yet (or it is unreadable) — start a fresh identity below.
  }
  const fresh: PushFile = { vapid: webpush.generateVAPIDKeys(), subs: [] };
  await write(fresh);
  return fresh;
}

async function write(file: PushFile): Promise<void> {
  cache = file;
  await fs.writeFile(env.PUSH_FILE, JSON.stringify(file, null, 2));
}

/** The half of the keypair the browser needs to subscribe. */
export async function publicKey(): Promise<string> {
  return (await read()).vapid.publicKey;
}

export async function deviceCount(): Promise<number> {
  return (await read()).subs.length;
}

/** Register a device. Re-subscribing the same endpoint refreshes it, never duplicates. */
export async function subscribe(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  label: string,
): Promise<void> {
  const file = await read();
  const others = file.subs.filter((s) => s.endpoint !== sub.endpoint);
  if (others.length >= MAX_SUBS) throw new Error("too many subscribed devices");
  await write({
    ...file,
    subs: [
      ...others,
      {
        endpoint: sub.endpoint,
        keys: sub.keys,
        label: label.slice(0, 120),
        addedAt: new Date().toISOString(),
      },
    ],
  });
}

export async function unsubscribe(endpoint: string): Promise<void> {
  const file = await read();
  const subs = file.subs.filter((s) => s.endpoint !== endpoint);
  if (subs.length !== file.subs.length) await write({ ...file, subs });
}

/**
 * Push to every subscribed device. Endpoints the push service has retired
 * (404/410) are dropped — an uninstalled app would otherwise fail forever.
 * The counts are for the settings page's "send test": a push that the service
 * refuses looks exactly like a delivered one from the pod's side otherwise.
 */
export async function send(payload: PushPayload, log: Logger): Promise<SendResult> {
  const file = await read();
  if (!file.subs.length) return { sent: 0, failed: 0 };
  webpush.setVapidDetails(VAPID_SUBJECT, file.vapid.publicKey, file.vapid.privateKey);
  const dead = new Set<string>();
  let sent = 0;
  let error: string | undefined;
  await Promise.all(
    file.subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify(payload),
          { TTL: 600 },
        );
        sent += 1;
      } catch (err) {
        const { statusCode: status, body } = err as { statusCode?: number; body?: string };
        error ??= status ? `HTTP ${status} ${String(body ?? "").trim()}`.trim() : String(err);
        if (status === 404 || status === 410) dead.add(s.endpoint);
        else log.warn(err, "web push failed");
      }
    }),
  );
  if (dead.size) {
    const current = await read();
    await write({ ...current, subs: current.subs.filter((s) => !dead.has(s.endpoint)) });
  }
  return { sent, failed: file.subs.length - sent, error };
}
