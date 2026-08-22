import type { FastifyInstance } from "fastify";
import { getMember } from "../council-store.js";
import { repoDirOr404, resolveInsideRepos } from "../paths.js";
import { reloadSchedules, runSchedule } from "../scheduler.js";
import * as store from "../schedules-store.js";

const NAME = { type: "string", minLength: 1, maxLength: 120 };
const CRON = { type: "string", minLength: 1, maxLength: 120 };
const PROMPT = { type: "string", minLength: 1, maxLength: 4000 };
// Up to 12h of spread; beyond that the schedule no longer means what it says.
const JITTER = { type: "integer", minimum: 0, maximum: 720 };

export default async function scheduleRoutes(app: FastifyInstance) {
  app.get("/api/schedules", async () => store.listSchedules());

  // The same list scoped to one repo, for the project screen's schedules tab.
  app.get<{ Params: { name: string } }>("/api/projects/:name/schedules", async (req, reply) => {
    if (!repoDirOr404(reply, req.params.name)) return;
    return store.listSchedules(req.params.name);
  });

  // The inbox: what every schedule did while nobody was watching.
  app.get("/api/runs", async () => store.listRuns());

  app.post<{
    Body: {
      name: string;
      kind?: "session" | "assistant";
      project?: string;
      cron: string;
      prompt: string;
      enabled?: boolean;
      jitterMinutes?: number;
      skipWhenIdle?: boolean;
      member?: string;
    };
  }>(
    "/api/schedules",
    {
      schema: {
        body: {
          type: "object",
          // project is required for a session schedule only, which the handler
          // enforces: an assistant schedule runs in no repo.
          required: ["name", "cron", "prompt"],
          additionalProperties: false,
          properties: {
            name: NAME,
            kind: { enum: ["session", "assistant"] },
            project: { type: "string", minLength: 1, maxLength: 200 },
            cron: CRON,
            prompt: PROMPT,
            enabled: { type: "boolean" },
            jitterMinutes: JITTER,
            skipWhenIdle: { type: "boolean" },
            member: { type: "string", pattern: "^([a-z][a-z0-9-]{0,31})?$" },
          },
        },
      },
    },
    async (req, reply) => {
      const kind = req.body.kind ?? "session";
      if (kind === "session") {
        if (!req.body.project) {
          return reply.code(400).send({ error: "a session schedule needs a project" });
        }
        try {
          resolveInsideRepos(req.body.project);
        } catch {
          return reply.code(404).send({ error: "not found" });
        }
      }
      if (!store.validCron(req.body.cron)) {
        return reply.code(400).send({ error: `not a cron pattern: ${req.body.cron}` });
      }
      // A member who does not exist would quietly fall back to the chair, and a
      // briefing answered in the wrong voice is the kind of wrong that reads as
      // working.
      if (req.body.member && !(await getMember(req.body.member))) {
        return reply.code(400).send({ error: `no such council member: ${req.body.member}` });
      }
      const schedule = await store.createSchedule({
        ...req.body,
        kind,
        project: req.body.project ?? "",
      });
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
      skipWhenIdle?: boolean;
      member?: string;
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
            skipWhenIdle: { type: "boolean" },
            member: { type: "string", pattern: "^([a-z][a-z0-9-]{0,31})?$" },
          },
        },
      },
    },
    async (req, reply) => {
      if (req.body.cron !== undefined && !store.validCron(req.body.cron)) {
        return reply.code(400).send({ error: `not a cron pattern: ${req.body.cron}` });
      }
      if (req.body.member && !(await getMember(req.body.member))) {
        return reply.code(400).send({ error: `no such council member: ${req.body.member}` });
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
  // that the previous run is still open. An assistant schedule answers with
  // what it said instead of with a session, since it starts none.
  app.post<{ Params: { id: string } }>("/api/schedules/:id/run", async (req, reply) => {
    const schedule = await store.getSchedule(req.params.id);
    if (!schedule) return reply.code(404).send({ error: "not found" });
    const outcome = await runSchedule(schedule.id, app.log);
    if (!outcome) {
      const after = await store.getSchedule(schedule.id);
      return reply.code(409).send({ error: after?.lastError ?? "could not start a session" });
    }
    return reply.code(201).send("session" in outcome ? outcome.session : { reply: outcome.reply });
  });
}
