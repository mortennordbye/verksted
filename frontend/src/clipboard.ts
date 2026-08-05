/**
 * Copy text, including where the Clipboard API does not exist.
 *
 * `navigator.clipboard` is only defined in a secure context, and the stated
 * deployment is plain HTTP over WireGuard — so on the actual target the copy
 * buttons called a method on `undefined` and silently did nothing. The
 * execCommand path is deprecated but is the only thing that works there.
 *
 * Returns whether the text made it, so callers can say so instead of leaving
 * the user to discover an empty paste later.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied by permissions policy, or not user-initiated — fall through.
    }
  }

  // A textarea rather than an input: it keeps newlines, which matters for the
  // ssh public keys this is mostly used for.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  // Off-screen but still focusable; display:none would not be selectable, and
  // iOS scrolls to a visible one.
  area.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
