/**
 * Whether today's Today has been seen and acknowledged, on this device.
 *
 * Today is the front door once a day: until you acknowledge it, opening the
 * app lands there; after that, "/" goes straight to the bench for the rest of
 * the day, and tomorrow Today is back. Kept per device in localStorage, keyed
 * by the local date, so a new day needs nothing to reset it. Storage that is
 * unavailable (a private window) reads as not acknowledged, which only ever
 * means showing Today once more than needed.
 */
const KEY = "vk.today.acked";

/** The local calendar day, 2026-09-14, which is what "today" means here. */
function dayKey(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function ackedToday(): boolean {
  try {
    return localStorage.getItem(KEY) === dayKey();
  } catch {
    return false;
  }
}

export function ackToday(): void {
  try {
    localStorage.setItem(KEY, dayKey());
  } catch {
    // Nothing to remember it in; Today simply shows again next time.
  }
}
