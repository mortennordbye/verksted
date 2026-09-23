import type { FastifyInstance } from "fastify";
import { planError, planHistory, planUsage } from "../plan.js";
import { archivedSessions } from "../session-reaper.js";
import { listSessions } from "../sessions-store.js";
import { summarize } from "../usage.js";

export default async function usageRoutes(app: FastifyInstance) {
  // Tokens over the last day, week and month, and the month by project. Read
  // from the session records, which are measured when a session ends. Sessions
  // that ended before there was a measurement are caught up by the daily
  // maintenance pass, not from here: this is a GET, and each one it measured
  // read a whole transcript off the volume.
  app.get("/api/usage", async () => {
    // Side by side: what was spent, from the transcripts, and what is left,
    // from the account. The second is best effort and null when it fails.
    const now = Date.now();
    // The retired sessions with the live ones: this page adds up every month
    // there has ever been, and history stopping at the retention window would
    // read as a year of nothing rather than as a year nobody kept.
    const [sessions, archived, plan] = await Promise.all([
      listSessions(),
      archivedSessions(),
      planUsage(),
    ]);
    const withHistory = plan && {
      ...plan,
      history: await planHistory(now - 7 * 24 * 60 * 60_000),
    };
    return summarize([...sessions, ...archived], now, withHistory, planError());
  });
}
