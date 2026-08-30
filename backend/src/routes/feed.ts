import type { FastifyInstance } from "fastify";
import type { FeedItem, Loop } from "../../../shared/api.js";
import * as feed from "../feed-store.js";
import * as journal from "../journal-store.js";
import * as loops from "../loops-store.js";
import { pollBench } from "../pollers.js";
import { runTriage } from "../scheduler.js";
import { listSessions } from "../sessions-store.js";

/**
 * The feed and the loops, as the screen and the tools read them.
 *
 * Reading the feed polls the bench first: its lists are on this volume and
 * cheap, so the feed is never behind a timer for anything local. State is set
 * from the screen only; the assistant's one write here is `did`.
 */
export default async function feedRoutes(app: FastifyInstance) {
  app.get("/api/feed", async (): Promise<FeedItem[]> => {
    await pollBench();
    return feed.list();
  });

  /** Judge what is waiting, now. The button for "why is this here". */
  app.post("/api/feed/triage", async (req) => ({ judged: await runTriage(req.log, true) }));

  app.post<{ Params: { id: string }; Body: { state: string; until?: string } }>(
    "/api/feed/:id/state",
    {
      schema: {
        params: { type: "object", properties: { id: { type: "string", maxLength: 300 } } },
        body: {
          type: "object",
          required: ["state"],
          additionalProperties: false,
          properties: {
            state: { enum: ["new", "seen", "done", "snoozed"] },
            until: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (req, reply) => {
      const state = req.body.state as FeedItem["state"];
      if (state === "snoozed" && !req.body.until) {
        return reply.code(400).send({ error: "snoozing needs an until" });
      }
      const item = await feed.setState(req.params.id, state, req.body.until ?? null);
      if (!item) return reply.code(404).send({ error: "not found" });
      return item;
    },
  );

  /** What the assistant did about an item; the tool's write. */
  app.post<{ Params: { id: string }; Body: { did: string } }>(
    "/api/feed/:id/did",
    {
      schema: {
        body: {
          type: "object",
          required: ["did"],
          additionalProperties: false,
          properties: { did: { type: "string", minLength: 1, maxLength: 300 } },
        },
      },
    },
    async (req, reply) => {
      const item = await feed.did(req.params.id, req.body.did);
      if (!item) return reply.code(404).send({ error: "not found" });
      return item;
    },
  );

  /**
   * Everything a briefing reads, in one call: what arrived that is not done,
   * the open loops, what is running or waiting, and the last few days. Text
   * rather than JSON because it is read by a model and re-sent with every
   * turn of the run that asked.
   */
  app.get("/api/feed/material", async (): Promise<{ text: string }> => {
    await pollBench();
    const [items, open, sessions, days] = await Promise.all([
      feed.list(),
      loops.list(),
      listSessions(),
      journal.recent(),
    ]);
    const live = items.filter((i) => i.state !== "done");
    const loud = live.filter((i) => i.urgency !== "quiet");
    const quiet = live.filter((i) => i.urgency === "quiet");
    const running = sessions.filter((s) => s.status !== "done");
    const lines = [
      "Since the last look:",
      loud.length
        ? loud.map((i) => `- [${i.urgency}] ${i.source}: ${i.title}. ${i.detail}`).join("\n")
        : "- nothing new",
      quiet.length ? `- and ${quiet.length} quiet thing(s): ${countBy(quiet)}` : "",
      "",
      "Open loops:",
      open.length ? loops.render(open) : "- none",
      "",
      "On the bench:",
      running.length
        ? running.map((s) => `- ${s.status}: ${s.project}, ${s.title}`).join("\n")
        : "- nothing running",
      "",
      days.length ? `The last few days:\n${journal.render(days)}` : "",
    ];
    return { text: lines.filter((l) => l !== "").join("\n") };
  });

  app.get("/api/loops", async (): Promise<Loop[]> => loops.list("all"));

  app.post<{ Body: { what: string; who?: string; from?: string; due?: string } }>(
    "/api/loops",
    {
      schema: {
        body: {
          type: "object",
          required: ["what"],
          additionalProperties: false,
          properties: {
            what: { type: "string", minLength: 1, maxLength: 300 },
            who: { type: "string", maxLength: 100 },
            from: { type: "string", maxLength: 300 },
            due: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return reply.code(201).send(await loops.open(req.body));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { slug: string } }>("/api/loops/:slug/close", async (req, reply) => {
    const loop = await loops.close(req.params.slug);
    if (!loop) return reply.code(404).send({ error: "not found" });
    return loop;
  });

  app.delete<{ Params: { slug: string } }>("/api/loops/:slug", async (req, reply) => {
    if (!(await loops.remove(req.params.slug))) return reply.code(404).send({ error: "not found" });
    return { slug: req.params.slug };
  });
}

function countBy(items: FeedItem[]): string {
  const counts = new Map<string, number>();
  for (const i of items) counts.set(i.source, (counts.get(i.source) ?? 0) + 1);
  return [...counts].map(([source, n]) => `${n} ${source}`).join(", ");
}
