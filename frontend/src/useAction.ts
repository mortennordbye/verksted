import { useCallback, useRef, useState } from "react";

/**
 * One mutation at a time, with somewhere for its failure to go.
 *
 * Every screen that writes had grown its own copy of this, and the two that had
 * not — the inbox row and the session menu — had no catch at all. Over a tunnel
 * that had dropped, "done" simply did nothing: the row stayed, the rejection
 * went to the console as an unhandled one, and nothing on screen said the pod
 * had not heard it.
 *
 * `run` answers whether the call went through, so what follows a tap — the undo
 * bar, a cleared draft, a navigation away — happens only when it did.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The guard reads a ref rather than `busy`: a handler bound once closes over
  // the state from the render that bound it, and a second tap would pass.
  const running = useRef(false);

  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    if (running.current) return false;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { busy, error, run, clearError };
}
