import { pollBench } from "./pollers.js";
import { sweepSessions } from "./sessions-store.js";

interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

/**
 * How often the volume is brought up to date with what tmux has.
 *
 * Nothing waits on this to know that a session is done: `status` comes from
 * whether tmux still has the session, so the hub says "done" the moment the
 * pane dies whatever this job has got round to. What arrives a tick later is
 * the writing-down — when it ended, what the repo had to show for it, what it
 * cost — so the cadence only has to be faster than somebody can notice the end
 * and look at the row.
 *
 * Close to the event stream's own three seconds, because that is what the old
 * behaviour amounted to: the sweep ran on whichever poll arrived first, and the
 * stream's was usually it.
 */
const EVERY_MS = 5_000;

/**
 * The one job that writes what the reads used to write.
 *
 * `GET /api/sessions` stamped ends and measured; `GET /api/usage` backfilled;
 * `GET /api/feed` filed the bench's own items (R-33);
 * every one of them from whichever client's timer happened to fire, several at
 * once, each over the whole history. What the volume did depended on who was
 * polling, which is where the sweep's stale-snapshot writes came from (R-09)
 * and why measuring a finished session could block a GET for as long as its
 * transcript took to read (R-10).
 *
 * Returns its own stop function. The other start helpers here return nothing,
 * which is exactly why none of them can be tested (R-35).
 */
export function startSweeper(log: Logger): () => void {
  let running = false;

  const tick = async (): Promise<void> => {
    // One pass at a time. A pass costs a `tmux ls` and a walk of the session
    // directory, and on a volume that is being slow those can outlast the
    // interval; two of them would stamp the same session twice.
    if (running) return;
    running = true;
    try {
      for (const id of await sweepSessions()) {
        log.info(`${id}: tmux no longer has it, end stamped`);
      }
    } catch (err) {
      // A repo deleted mid-measure, or tmux briefly unavailable. Next tick.
      log.warn(err, "session sweep failed");
    }
    try {
      // After the sessions, so an end stamped this tick is filed this tick.
      await pollBench();
    } catch (err) {
      log.warn(err, "bench filing failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), EVERY_MS);
  // Housekeeping must never be the reason the process stays up.
  timer.unref?.();
  void tick();
  return () => clearInterval(timer);
}
