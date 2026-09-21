/**
 * localStorage, for the preferences that are not worth a round trip.
 *
 * Every accessor here is wrapped, because `localStorage` is not a plain object
 * on every device this app is opened on: Safari with "block all cookies", a
 * private window, an iframe with third-party storage partitioned off and a full
 * quota all throw on the *getter* rather than returning null. Half of these
 * reads run during render — the terminal's font size, the session's split ratio
 * — so the throw took the screen with it rather than the preference.
 *
 * Nothing kept here is worth recovering. A device that cannot remember a pane
 * width shows the default one.
 */

export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Blocked or over quota: this visit keeps the value in React state anyway.
  }
}

export function removeStored(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // Nothing was stored to remove.
  }
}

/** A stored number, clamped — what is in storage is user-editable text. */
export function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
  const n = Number(readStored(key));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
