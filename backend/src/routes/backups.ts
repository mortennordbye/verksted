import type { FastifyInstance } from "fastify";
import type { BackupStatus } from "../../../shared/api.js";
import { env } from "../env.js";
import * as backups from "../backups-store.js";

export default async function backupRoutes(app: FastifyInstance) {
  app.get("/api/backups", async (): Promise<BackupStatus> => backups.status());

  // No body: what a backup contains is decided by the script and the env, never
  // by the caller. There is nothing here for a client to point somewhere else.
  app.post("/api/backups", async (_req, reply) => {
    if (!backups.start(env.VK_BACKUP_KEEP, app.log)) {
      return reply.code(409).send({ error: "a backup is already running" });
    }
    return reply.code(202).send(await backups.status());
  });
}
