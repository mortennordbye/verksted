/**
 * Memoize an async result for a short window, keyed by a string.
 *
 * For the polls the UI runs on a timer from every open tab, where the work
 * behind the answer costs far more than the answer's staleness: readlinking
 * every fd of every pid in /proc, or two GitHub API calls per request per tab.
 *
 * Concurrent callers share one in-flight promise rather than each starting
 * their own, which is most of the win — several tabs polling in lockstep is
 * exactly the case this exists for. Failures are not cached, so a transient
 * error does not stick around for the rest of the window.
 */
export function ttlCache<T>(
  ttlMs: number,
  fn: (key: string) => Promise<T>,
): (key?: string) => Promise<T> {
  const hits = new Map<string, { at: number; value: Promise<T> }>();

  return (key = "") => {
    const now = Date.now();
    const hit = hits.get(key);
    if (hit && now - hit.at < ttlMs) return hit.value;

    // Keyed by project, so the map is bounded by how many projects exist — but
    // drop what has expired rather than assuming that stays small.
    for (const [k, v] of hits) {
      if (now - v.at >= ttlMs) hits.delete(k);
    }

    const value = fn(key).catch((err: unknown) => {
      hits.delete(key);
      throw err;
    });
    hits.set(key, { at: now, value });
    return value;
  };
}
