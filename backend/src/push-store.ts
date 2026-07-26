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

/** One phone, one tablet, a laptop… a cap, not a design limit. */
const MAX_SUBS = 20;

// Push services want a contact for the sender; nobody reads it on a self-hosted
// deployment, it only has to parse as a mailto/https URL.
const VAPID_SUBJECT = "mailto:verksted@localhost";

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
 */
export async function send(payload: PushPayload, log: Logger): Promise<void> {
  const file = await read();
  if (!file.subs.length) return;
  webpush.setVapidDetails(VAPID_SUBJECT, file.vapid.publicKey, file.vapid.privateKey);
  const dead = new Set<string>();
  await Promise.all(
    file.subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: s.keys },
          JSON.stringify(payload),
          { TTL: 600 },
        );
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) dead.add(s.endpoint);
        else log.warn(err, "web push failed");
      }
    }),
  );
  if (dead.size) {
    const current = await read();
    await write({ ...current, subs: current.subs.filter((s) => !dead.has(s.endpoint)) });
  }
}
