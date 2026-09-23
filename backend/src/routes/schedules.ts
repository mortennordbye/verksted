import type { FastifyInstance } from "fastify";
import type { CronPreview, MaintainerStage, ScheduleTrigger } from "../../../shared/api.js";
import { getMember } from "../council-store.js";
import { repoDirOr404, resolveInsideRepos } from "../paths.js";
import { reloadSchedules, runSchedule } from "../scheduler.js";
import * as store from "../schedules-store.js";

const NAME = { type: "string", minLength: 1, maxLength: 120 };
const CRON = { type: "string", minLength: 1, maxLength: 120 };
// A stored cron may be empty, which the handlers allow only beside a trigger.
const SCHEDULE_CRON = { type: "string", maxLength: 120 };
const TRIGGER = { enum: ["review", "pr", "ci-failed", null] };
// Empty is allowed by the schema and refused by the handler, since a stage
// schedule has a prompt of its own and this is then only notes.
const PROMPT = { type: "string", maxLength: 4000 };
const STAGE = { enum: ["scout", "build", "gate"] };
// Up to 12h of spread; beyond that the schedule no longer means what it says.
const JITTER = { type: "integer", minimum: 0, maximum: 720 };

export default async function scheduleRoutes(app: FastifyInstance) {
  app.get("/api/schedules", async () => store.listSchedules());

  // The same list scoped to one repo, for the project screen's schedules tab.
  app.get<{ Params: { name: string } }>("/api/projects/:name/schedules", async (req, reply) => {
    if (!repoDirOr404(reply, req.params.name)) return;
    return store.listSchedules(req.params.name);
  });

  /**
   * What a pattern would do, for the field somebody is typing it into.
   *
   * Read here rather than in the browser because a cron is wall-clock time in
   * the pod's timezone: a phone in another one would preview the wrong hours,
   * which is exactly the mistake this is meant to catch.
   */
  app.get<{ Querystring: { cron: string } }>(
    "/api/schedules/preview",
    {
      schema: {
        querystring: {
          type: "object",
          required: ["cron"],
          additionalProperties: false,
          properties: { cron: CRON },
        },
      },
    },
    async (req): Promise<CronPreview> => {
      const next = store.nextRuns(req.query.cron);
      return { valid: next.length > 0, next };
    },
  );

  // The inbox: what every schedule did while nobody was watching.
  app.get("/api/runs", async () => store.listRuns());

  /** Wave off what a run said, until the schedule says something else. */
  app.post<{ Params: { id: string }; Body: { at: string } }>(
    "/api/schedules/:id/dismiss",
    {
      schema: {
        body: {
          type: "object",
          required: ["at"],
          additionalProperties: false,
          properties: { at: { type: "string", format: "date-time" } },
        },
      },
    },
    async (req, reply) => {
      if (!(await store.dismissRun(req.params.id, req.body.at))) {
        return reply.code(404).send({ error: "no such run" });
      }
      return { ok: true };
    },
  );

  /** Take the wave-off back: the undo on the card that was just dismissed. */
  app.post<{ Params: { id: string } }>("/api/schedules/:id/undismiss", async (req, reply) => {
    if (!(await store.undismissRun(req.params.id))) {
      return reply.code(404).send({ error: "no such schedule" });
    }
    return { ok: true };
  });

  app.post<{
    Body: {
      name: string;
      kind?: "session" | "assistant";
      project?: string;
      cron: string;
      prompt?: string;
      enabled?: boolean;
      jitterMinutes?: number;
      skipWhenIdle?: boolean;
      member?: string;
      convenes?: boolean;
      stage?: MaintainerStage;
      trigger?: ScheduleTrigger | null;
    };
  }>(
    "/api/schedules",
    {
      schema: {
        body: {
          type: "object",
          // project is required for a session schedule only, which the handler
          // enforces: an assistant schedule runs in no repo.
          required: ["name", "cron"],
          additionalProperties: false,
          properties: {
            name: NAME,
            kind: { enum: ["session", "assistant"] },
            project: { type: "string", minLength: 1, maxLength: 200 },
            cron: SCHEDULE_CRON,
            prompt: PROMPT,
            enabled: { type: "boolean" },
            jitterMinutes: JITTER,
            skipWhenIdle: { type: "boolean" },
            member: { type: "string", pattern: "^([a-z][a-z0-9-]{0,31})?$" },
            convenes: { type: "boolean" },
            stage: STAGE,
            trigger: TRIGGER,
          },
        },
      },
    },
    async (req, reply) => {
      const kind = req.body.kind ?? "session";
      const prompt = req.body.prompt?.trim() ?? "";
      if (!prompt && !(kind === "session" && req.body.stage)) {
        return reply.code(400).send({ error: "a schedule needs a prompt" });
      }
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
      const cron = req.body.cron.trim();
      const shape = store.shapeError({
        // What would be stored: an assistant schedule keeps no project.
        project: kind === "session" ? (req.body.project ?? "") : "",
        cron,
        trigger: req.body.trigger ?? null,
      });
      if (shape) return reply.code(400).send({ error: shape });
      // A member who does not exist would quietly fall back to the chair, and a
      // briefing answered in the wrong voice is the kind of wrong that reads as
      // working.
      if (req.body.member && !(await getMember(req.body.member))) {
        return reply.code(400).send({ error: `no such council member: ${req.body.member}` });
      }
      const schedule = await store.createSchedule({
        ...req.body,
        kind,
        cron,
        prompt,
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
      convenes?: boolean;
      trigger?: ScheduleTrigger | null;
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
            cron: SCHEDULE_CRON,
            prompt: PROMPT,
            enabled: { type: "boolean" },
            jitterMinutes: JITTER,
            skipWhenIdle: { type: "boolean" },
            member: { type: "string", pattern: "^([a-z][a-z0-9-]{0,31})?$" },
            convenes: { type: "boolean" },
            trigger: TRIGGER,
          },
        },
      },
    },
    async (req, reply) => {
      if (req.body.cron !== undefined) req.body.cron = req.body.cron.trim();
      // Either half of what fires it may change, so the whole is checked as it
      // would be stored after this patch.
      if (req.body.cron !== undefined || req.body.trigger !== undefined) {
        const existing = await store.getSchedule(req.params.id);
        if (!existing) return reply.code(404).send({ error: "not found" });
        const shape = store.shapeError({
          project: existing.project,
          cron: req.body.cron ?? existing.cron,
          trigger: req.body.trigger === undefined ? existing.trigger : req.body.trigger,
        });
        if (shape) return reply.code(400).send({ error: shape });
      }
      if (req.body.member && !(await getMember(req.body.member))) {
        return reply.code(400).send({ error: `no such council member: ${req.body.member}` });
      }
      // Whether a schedule runs a stage is fixed at creation, like its project,
      // so an emptied prompt is fine exactly when a stage's own prompt remains.
      if (req.body.prompt !== undefined && !req.body.prompt.trim()) {
        const existing = await store.getSchedule(req.params.id);
        if (!existing) return reply.code(404).send({ error: "not found" });
        if (!existing.stage) return reply.code(400).send({ error: "a schedule needs a prompt" });
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
  // what it said instead of with a session, since it starts none; the settings
  // page waits for that, because reading it is why the button was pressed. The
  // assistant's own tool does not (`wait: false`): its call is inside a turn,
  // and a run is another whole turn. How that one went is on the schedule.
  //
  // No body schema: the button posts none at all, which a schema for an object
  // refuses. The one field is compared with a literal instead.
  app.post<{ Params: { id: string }; Body: { wait?: unknown } | undefined }>(
    "/api/schedules/:id/run",
    async (req, reply) => {
      const schedule = await store.getSchedule(req.params.id);
      if (!schedule) return reply.code(404).send({ error: "not found" });
      if (req.body?.wait === false && schedule.kind === "assistant") {
        void runSchedule(schedule.id, app.log).catch((err: unknown) =>
          app.log.warn(err, `schedule ${schedule.id} failed`),
        );
        return reply.code(202).send({ id: schedule.id });
      }
      const outcome = await runSchedule(schedule.id, app.log);
      if (!outcome) {
        const after = await store.getSchedule(schedule.id);
        return reply.code(409).send({ error: after?.lastError ?? "could not start a session" });
      }
      return reply
        .code(201)
        .send("session" in outcome ? outcome.session : { reply: outcome.reply });
    },
  );
}
