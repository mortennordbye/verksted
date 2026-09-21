/**
 * Open the jump-to palette from anywhere.
 *
 * It lives in App, and the only way in was Cmd/Ctrl+K — which a phone does
 * not have (F-35). A button in the top bar says so through this rather than
 * through a context threaded down every screen: there is one palette, one
 * listener, and nothing to pass.
 */
const EVENT = "vk:palette";

export function openPalette(): void {
  dispatchEvent(new Event(EVENT));
}

/** App's half: called whenever something asks for the palette. */
export function onPaletteAsked(open: () => void): () => void {
  addEventListener(EVENT, open);
  return () => removeEventListener(EVENT, open);
}
