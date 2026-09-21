import { useLocation, useNavigate } from "react-router";

/**
 * An overlay whose being open is a place in the URL rather than state.
 *
 * The file open in a session's viewer and the document open in the Docs viewer
 * were component state, so a reload or an evicted iOS app closed them, and
 * neither could be sent to anybody as a link. As a search param they survive
 * both, and Back works the way it does for any other place: opening pushes an
 * entry, Back pops it, and the overlay closes because its param is gone. These
 * overlays therefore do not use `useDismissOnBack`'s own history entry.
 *
 * Closing from inside (the ✕, Escape, a click away) steps Back over the entry
 * this pushed. An overlay that arrived open, from a link or a reload of a fresh
 * tab, has no entry of ours to step back over: that one takes its params out
 * of the URL in place instead, so closing it never leaves the screen.
 *
 * `keys[0]` is what says the overlay is open; the rest ride along with it
 * (which line, which kind of diff) and are cleared with it.
 */
export function useUrlOverlay<K extends string>(keys: readonly [K, ...K[]]) {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k)])) as Record<
    K,
    string | null
  >;
  const isOpen = values[keys[0]] !== null;
  const state = (location.state ?? {}) as Record<string, unknown>;

  const search = (next: Partial<Record<K, string>>) => {
    const out = new URLSearchParams(location.search);
    for (const k of keys) out.delete(k);
    for (const [k, v] of Object.entries(next)) if (typeof v === "string") out.set(k, v);
    const s = out.toString();
    return { search: s ? `?${s}` : "", hash: location.hash };
  };

  const show = (next: Partial<Record<K, string>>) =>
    void navigate(
      search(next),
      // One already open is swapped in place, entry and all: Back leaves the
      // overlay rather than walking back through everything looked at in it.
      isOpen ? { replace: true, state: location.state } : { state: { ...state, overlay: keys[0] } },
    );

  const hide = () => {
    if (!isOpen) return;
    if (state.overlay === keys[0]) void navigate(-1);
    else void navigate(search({}), { replace: true, state: location.state });
  };

  return { values, isOpen, show, hide };
}
