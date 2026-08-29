import type { FastifyInstance } from "fastify";
import { backfillUsage, listSessions } from "../sessions-store.js";
import { summarize } from "../usage.js";

export default async function usageRoutes(app: FastifyInstance) {
  // Tokens over the last day, week and month, and the month by project. Read
  // from the session records, which are measured when a session ends; the
  // backfill measures the ones that ended before there was a measurement.
  app.get("/api/usage", async () => {
    await backfillUsage();
    return summarize(await listSessions());
  });
}
