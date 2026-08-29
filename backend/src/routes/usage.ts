import type { FastifyInstance } from "fastify";
import { planHistory, planUsage } from "../plan.js";
import { backfillUsage, listSessions } from "../sessions-store.js";
import { summarize } from "../usage.js";

export default async function usageRoutes(app: FastifyInstance) {
  // Tokens over the last day, week and month, and the month by project. Read
  // from the session records, which are measured when a session ends; the
  // backfill measures the ones that ended before there was a measurement.
  app.get("/api/usage", async () => {
    await backfillUsage();
    // Side by side: what was spent, from the transcripts, and what is left,
    // from the account. The second is best effort and null when it fails.
    const now = Date.now();
    const [sessions, plan] = await Promise.all([listSessions(), planUsage()]);
    const withHistory = plan && {
      ...plan,
      history: await planHistory(now - 7 * 24 * 60 * 60_000),
    };
    return summarize(sessions, now, withHistory);
  });
}
