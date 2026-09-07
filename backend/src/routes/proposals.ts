import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ProposalAction } from "../../../shared/api.js";
import * as calendar from "../calendar.js";
import * as feed from "../feed-store.js";
import * as mail from "../mail.js";
import { announce } from "../notifier.js";

/**
 * Proposals: the tap.
 *
 * Anything with no undo is prepared in full by the assistant, filed as a feed
 * item that shows the whole thing, and executed here when the person taps it.
 * The card is the authorisation; nothing a model says reaches `do` without
 * one. Sending a mail, putting an event on the calendar, merging, ending a
 * running session and deleting a schedule were the five, and they go through
 * the app's own routes so every validation those routes make holds here too.
 *
 * Starting a session joined them, for a different reason than having no undo:
 * the chair reads the documents and the mail now, and a session is the one
 * thing it can do that text nobody here wrote could usefully ask for — an agent
 * with a shell on the pod, holding gh, kubectl and git. The tap is what stands
 * between the two.
 */
const ACTION = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: {
      enum: [
        "send",
        "calendar_put",
        "merge_pr",
        "end_session",
        "delete_schedule",
        "start_session",
        "desk_session",
      ],
    },
  },
};

/** What the card says, from what the action is. */
export function describe(a: ProposalAction): { title: string; detail: string } {
  switch (a.kind) {
    case "send":
      return { title: `Send to ${a.to}: ${a.subject}`, detail: a.body };
    case "calendar_put":
      return {
        title: `Put on the calendar: ${a.summary}`,
        detail: `${a.start} to ${a.end}${a.location ? `, ${a.location}` : ""}${a.description ? `\n${a.description}` : ""}`,
      };
    case "merge_pr":
      return { title: `Merge ${a.project} #${a.number}`, detail: "squash, delete the branch" };
    case "end_session":
      return { title: `End session ${a.id}`, detail: "the agent stops; unwritten work goes" };
    case "delete_schedule":
      return { title: `Delete schedule ${a.id}`, detail: "its run history goes with it" };
    case "start_session":
      return {
        title: `Start ${a.agent} in ${a.project}${a.title ? `: ${a.title}` : ""}`,
        detail: a.prompt || "no first prompt; it waits for you at the terminal",
      };
    case "desk_session":
      return { title: `Start a desk session: ${a.title}`, detail: a.ask };
  }
}

/** The action's own fields, checked before it is shown to anyone. */
export function validateAction(a: Record<string, unknown>): ProposalAction {
  const str = (k: string, max: number, required = true): string => {
    const v = a[k];
    if (typeof v !== "string" || (required && !v.trim())) throw new Error(`${k} is required`);
    if (v.length > max) throw new Error(`${k} is too long`);
    return v;
  };
  switch (a.kind) {
    case "send": {
      const to = str("to", 300);
      if (!/^[^\s@,;]+@[^\s@,;]+(\s*[,;]\s*[^\s@,;]+@[^\s@,;]+)*$/.test(to.trim())) {
        throw new Error("to must be one or more addresses");
      }
      const inReplyTo = typeof a.inReplyTo === "string" ? a.inReplyTo.slice(0, 300) : undefined;
      return {
        kind: "send",
        to: to.trim(),
        subject: str("subject", 300),
        body: str("body", 20_000),
        ...(inReplyTo ? { inReplyTo } : {}),
      };
    }
    case "calendar_put": {
      const start = str("start", 40);
      const end = str("end", 40);
      if (Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) {
        throw new Error("start and end must be dates");
      }
      if (Date.parse(end) <= Date.parse(start)) throw new Error("end must be after start");
      const location = typeof a.location === "string" ? a.location.slice(0, 300) : undefined;
      const description =
        typeof a.description === "string" ? a.description.slice(0, 2000) : undefined;
      return {
        kind: "calendar_put",
        summary: str("summary", 300),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        ...(location ? { location } : {}),
        ...(description ? { description } : {}),
      };
    }
    case "merge_pr": {
      const number = Number(a.number);
      if (!Number.isInteger(number) || number <= 0) throw new Error("number must be a PR number");
      return { kind: "merge_pr", project: str("project", 100), number };
    }
    case "end_session":
      return { kind: "end_session", id: str("id", 100) };
    case "delete_schedule":
      return { kind: "delete_schedule", id: str("id", 100) };
    case "start_session": {
      const agent = str("agent", 20);
      // The same three the session route takes. Checked here rather than left
      // to the tap, so a card that could never run is refused as it is filed.
      if (agent !== "claude" && agent !== "antigravity" && agent !== "codex") {
        throw new Error("agent must be claude, antigravity or codex");
      }
      const title = typeof a.title === "string" ? a.title.slice(0, 200) : undefined;
      const prompt = typeof a.prompt === "string" ? a.prompt.slice(0, 20_000) : undefined;
      return {
        kind: "start_session",
        project: str("project", 100),
        agent,
        ...(title ? { title } : {}),
        ...(prompt ? { prompt } : {}),
      };
    }
    case "desk_session":
      return { kind: "desk_session", title: str("title", 200), ask: str("ask", 20_000) };
    default:
      throw new Error("unknown kind");
  }
}

export default async function proposalRoutes(app: FastifyInstance) {
  app.post<{ Body: { action: Record<string, unknown>; why?: string } }>(
    "/api/proposals",
    {
      schema: {
        body: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: { action: ACTION, why: { type: "string", maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      let action: ProposalAction;
      try {
        action = validateAction(req.body.action);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const { title, detail } = describe(action);
      const id = `proposal:${randomUUID()}`;
      const { item } = await feed.upsert({
        id,
        source: "proposal",
        at: new Date().toISOString(),
        title,
        detail: req.body.why ? `${req.body.why}\n\n${detail}` : detail,
        link: `/runs#${id}`,
        version: "proposed",
        urgency: "attention",
        action,
      });
      // The one push that is not triage's: a proposal is the assistant
      // asking, and asking is worth a phone.
      await announce(
        { title: "tap to decide", body: title.slice(0, 500), url: `/runs#${id}`, tag: "bell" },
        req.log,
      );
      await feed.markPushed(id);
      return reply.code(201).send(item);
    },
  );

  app.post<{ Params: { id: string } }>("/api/proposals/:id/do", async (req, reply) => {
    const item = await feed.get(req.params.id);
    if (!item || item.source !== "proposal" || !item.action) {
      return reply.code(404).send({ error: "no such proposal" });
    }
    if (item.state === "done") return reply.code(409).send({ error: `already ${item.did}` });
    try {
      const did = await execute(app, item.action);
      await feed.resolve(item.id, did);
      return feed.get(item.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof mail.MailUnavailable || err instanceof calendar.CalendarUnavailable
          ? 503
          : 502;
      req.log.warn(err, `proposal ${item.id} failed`);
      return reply.code(code).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>("/api/proposals/:id/drop", async (req, reply) => {
    const item = await feed.get(req.params.id);
    if (!item || item.source !== "proposal")
      return reply.code(404).send({ error: "no such proposal" });
    await feed.resolve(item.id, "dropped");
    return feed.get(item.id);
  });
}

/** Through the app's own routes, so their checks are these checks. */
async function execute(app: FastifyInstance, a: ProposalAction): Promise<string> {
  switch (a.kind) {
    case "send": {
      const { messageId } = await mail.send(a);
      return `sent to ${a.to}${messageId ? ` (${messageId})` : ""}`;
    }
    case "calendar_put": {
      const { uid } = await calendar.put(a);
      return `put on the calendar (${uid})`;
    }
    case "merge_pr": {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${encodeURIComponent(a.project)}/prs/${a.number}/merge`,
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `merged #${a.number}`;
    }
    case "end_session": {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/sessions/${encodeURIComponent(a.id)}`,
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `ended ${a.id}`;
    }
    case "delete_schedule": {
      const res = await app.inject({
        method: "DELETE",
        url: `/api/schedules/${encodeURIComponent(a.id)}`,
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `deleted schedule ${a.id}`;
    }
    case "start_session": {
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${encodeURIComponent(a.project)}/sessions`,
        // Nobody is attached to a session started off a card either, so the
        // same reasoning the tool had applies: routine calls are approved and
        // the rest still stops, surfacing as a waiting session that pushes.
        payload: {
          agent: a.agent,
          ...(a.title ? { title: a.title } : {}),
          ...(a.prompt ? { prompt: a.prompt } : {}),
          autoPermissions: true,
        },
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `started ${res.json<{ id: string }>().id}`;
    }
    case "desk_session": {
      const res = await app.inject({
        method: "POST",
        url: "/api/desk/sessions",
        payload: { title: a.title, ask: a.ask },
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `started ${res.json<{ id: string }>().id} at the desk`;
    }
  }
}

function errorOf(res: { statusCode: number; body: string }): string {
  try {
    return (JSON.parse(res.body) as { error?: string }).error ?? `HTTP ${res.statusCode}`;
  } catch {
    return `HTTP ${res.statusCode}`;
  }
}
