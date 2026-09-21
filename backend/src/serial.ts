/**
 * One chain of work per key, so two changes to the same record never overlap.
 *
 * Every store here is read-modify-write over one JSON file: read it, change a
 * field, write the whole thing back. Run two of those beside each other and
 * both read the same version, so whichever finishes last silently drops the
 * other's change — a review mark that will not stick, a run record the UI's
 * next PATCH erases, a schedule that a delete removed and a stamp put back.
 *
 * The read has to happen inside the queued function, not before it: queueing a
 * write over a value read outside is the same race with extra steps.
 *
 * Chaining is enough for what this guards. These are one person's taps and one
 * scheduler's ticks over a handful of small files, not a contended resource —
 * and a failed change must not block the next one, so the chain continues past
 * a rejection either way.
 */
export function keyedQueue(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const chains = new Map<string, Promise<unknown>>();

  return <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const queued = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
    chains.set(key, queued);
    return queued.finally(() => {
      // Last one out clears the entry, so the map does not keep a key per
      // record for the life of the process.
      if (chains.get(key) === queued) chains.delete(key);
    });
  };
}

/**
 * A queue that is full. Refused, not failed: the work was never started, the
 * caller should say "later", and a route answers it with 429 rather than 5xx.
 */
export class BusyError extends Error {}
