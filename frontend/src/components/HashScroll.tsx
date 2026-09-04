import { useEffect } from "react";
import { useLocation } from "react-router";

/**
 * Take a `#id` in the URL to the thing it names.
 *
 * Most deep links in the app are one — an inbox item, a settings panel — and
 * none of them arrived anywhere. The browser only scrolls to a hash target
 * that was in the document when the page loaded; these are drawn a poll later,
 * and react-router does nothing about the hash on its own. So a row on Today
 * opened the inbox at the top and the item it meant was four screens down,
 * which reads as a link that did not work.
 *
 * Hence the wait: look now, and if the target is not there yet, watch until it
 * is. The watch is dropped on the first hit, on the next navigation, and after
 * a few seconds regardless — a hash naming something the screen will never
 * draw must not leave an observer on the document for the life of the tab.
 */
const GIVE_UP_MS = 5_000;

export default function HashScroll() {
  const { hash, key } = useLocation();

  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;

    // Landing exactly on the row hides it under the sticky top bar; the
    // targets that care say so themselves with a scroll-margin class.
    const reach = () => {
      const el = document.getElementById(id);
      el?.scrollIntoView({ block: "start" });
      return !!el;
    };
    if (reach()) return;

    const observer = new MutationObserver(() => {
      if (reach()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const giveUp = setTimeout(() => observer.disconnect(), GIVE_UP_MS);

    return () => {
      observer.disconnect();
      clearTimeout(giveUp);
    };
    // `key` changes on every navigation, so tapping the same link twice scrolls
    // back to the row a second time rather than doing nothing.
  }, [hash, key]);

  return null;
}
