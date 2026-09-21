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

/**
 * Open the keyboard shortcut sheet from anywhere: the `?` key, or the palette's
 * own entry for it. Same shape as the palette's event, for the same reason.
 */
const SHORTCUTS = "vk:shortcuts";

export function openShortcuts(): void {
  dispatchEvent(new Event(SHORTCUTS));
}

export function onShortcutsAsked(open: () => void): () => void {
  addEventListener(SHORTCUTS, open);
  return () => removeEventListener(SHORTCUTS, open);
}
