import type { FastifyInstance } from "fastify";
import type { MaintainerIssue } from "../../../shared/api.js";
import { listQueue } from "../maintainer.js";
import { resolveInsideRepos } from "../paths.js";
import { listSchedules } from "../schedules-store.js";

export default async function maintainerRoutes(app: FastifyInstance) {
  // The queue, across every repo a maintainer stage is scheduled in. A repo
  // whose gh cannot answer is logged and skipped rather than blanking the rest.
  app.get("/api/maintainer/queue", async (req) => {
    const projects = new Set(
      (await listSchedules()).filter((s) => s.stage && s.project).map((s) => s.project),
    );
    const out: MaintainerIssue[] = [];
    for (const project of projects) {
      try {
        out.push(...(await listQueue(resolveInsideRepos(project), project)));
      } catch (err) {
        req.log.warn(err, `maintainer queue for ${project} unavailable`);
      }
    }
    return out;
  });
}
