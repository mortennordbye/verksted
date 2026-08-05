import type { FastifyInstance } from "fastify";
import { resolveInsideRepos } from "../paths.js";
import { reloadSchedules, runSchedule } from "../scheduler.js";
import * as store from "../schedules-store.js";

const NAME = { type: "string", minLength: 1, maxLength: 120 };
const CRON = { type: "string", minLength: 1, maxLength: 120 };
const PROMPT = { type: "string", minLength: 1, maxLength: 4000 };
// Up to 12h of spread; beyond that the schedule no longer means what it says.
const JITTER = { type: "integer", minimum: 0, maximum: 720 };

export default async function scheduleRoutes(app: FastifyInstance) {
  app.get("/api/schedules", async () => store.listSchedules());

  app.post<{
    Body: {
      name: string;
      project: string;
      cron: string;
      prompt: string;
      enabled?: boolean;
      jitterMinutes?: number;
    };
  }>(
    "/api/schedules",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "project", "cron", "prompt"],
          additionalProperties: false,
          properties: {
            name: NAME,
            project: { type: "string", minLength: 1, maxLength: 200 },
            cron: CRON,
            prompt: PROMPT,
            enabled: { type: "boolean" },
            jitterMinutes: JITTER,
          },
        },
      },
    },
    async (req, reply) => {
      try {
        resolveInsideRepos(req.body.project);
      } catch {
        return reply.code(404).send({ error: "not found" });
      }
      if (!store.validCron(req.body.cron)) {
        return reply.code(400).send({ error: `not a cron pattern: ${req.body.cron}` });
      }
      const schedule = await store.createSchedule(req.body);
      await reloadSchedules(app.log);
      return reply.code(201).send(schedule);
    },
  );

  // The project a schedule runs in is fixed at creation: changing it would
  // leave the run history pointing at sessions in another repo.
  app.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      cron?: string;
      prompt?: string;
      enabled?: boolean;
      jitterMinutes?: number;
    };
  }>(
    "/api/schedules/:id",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
          name: NAME,
          cron: CRON,
          prompt: PROMPT,
          enabled: { type: "boolean" },
          jitterMinutes: JITTER,
        },
        },
      },
    },
    async (req, reply) => {
      if (req.body.cron !== undefined && !store.validCron(req.body.cron)) {
        return reply.code(400).send({ error: `not a cron pattern: ${req.body.cron}` });
      }
      const schedule = await store.updateSchedule(req.params.id, req.body);
      if (!schedule) return reply.code(404).send({ error: "not found" });
      await reloadSchedules(app.log);
      return schedule;
    },
  );

  app.delete<{ Params: { id: string } }>("/api/schedules/:id", async (req, reply) => {
    if (!(await store.deleteSchedule(req.params.id))) {
      return reply.code(404).send({ error: "not found" });
    }
    await reloadSchedules(app.log);
    return { id: req.params.id };
  });

  // Run now. Same path as a tick, so it reports the same refusals — notably
  // that the previous run is still open.
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req, reply) => {
    const schedule = await store.getSchedule(req.params.id);
    if (!schedule) return reply.code(404).send({ error: "not found" });
    const session = await runSchedule(schedule.id, app.log);
    if (!session) {
      const after = await store.getSchedule(schedule.id);
      return reply.code(409).send({ error: after?.lastError ?? "could not start a session" });
    }
    return reply.code(201).send(session);
  });
}
