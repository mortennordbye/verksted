import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GmailRule, ProposalAction } from "../../../shared/api.js";
import * as calendar from "../calendar.js";
import * as feed from "../feed-store.js";
import * as toolLog from "../tool-log.js";
import * as gmail from "../gmail.js";
import * as mail from "../mail.js";
import { announce } from "../notifier.js";

/**
 * Proposals: the tap.
 *
 * Anything with no undo is prepared in full by the assistant, filed as a feed
 * item that shows the whole thing, and executed here when the person taps it.
 * The card is the authorisation; nothing a model says reaches `do` without
 * one. That is true of a model, which reaches this app only through its tool
 * server. It is not a boundary against a process on the pod, which can post to
 * `do` with the id alone (S-05; SECURITY.md says so, BACKLOG has the fix). Sending a mail, putting an event on the calendar, merging, ending a
 * running session and deleting a schedule were the five, and they go through
 * the app's own routes so every validation those routes make holds here too.
 *
 * Starting a session joined them, for a different reason than having no undo:
 * the chair reads the documents and the mail now, and a session is the one
 * thing it can do that text nobody here wrote could usefully ask for — an agent
 * with a shell on the pod, holding gh, kubectl and git. The tap is what stands
 * between the two.
 *
 * The mail and calendar changes with no way back came last (A-08, A-09), and
 * they differ in one respect: they have no route of their own to go through.
 * The card is the only caller their functions have, because an address that
 * deleted a label for whoever asked would be the way round the card.
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
        "schedule_put",
        "run_schedule",
        "mail_rule_put",
        "mail_rule_delete",
        "mail_label_delete",
        "calendar_delete",
        "mail_move",
      ],
    },
  },
};

/** A filter on one line: what it matches, then what it does to a match. */
function ruleText(r: Omit<GmailRule, "id" | "archive" | "markRead"> & Partial<GmailRule>): string {
  const match = [r.from && `from:${r.from}`, r.subject && `subject:${r.subject}`, r.query];
  const does = [r.label && `label ${r.label}`, r.archive && "archive", r.markRead && "mark read"];
  return `${match.filter(Boolean).join(" ")} -> ${does.filter(Boolean).join(", ")}`;
}

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
    case "schedule_put":
      return {
        title: a.id ? `Change schedule ${a.id}` : `Schedule "${a.name}" in ${a.project}, ${a.cron}`,
        detail:
          [
            a.name && !a.id ? null : a.name ? `name: ${a.name}` : null,
            a.cron ? `cron: ${a.cron}` : null,
            a.enabled === undefined ? null : a.enabled ? "enabled" : "paused",
            a.jitterMinutes === undefined ? null : `jitter: ${a.jitterMinutes} min`,
          ]
            .filter(Boolean)
            .join("\n") + (a.prompt ? `\n\n${a.prompt}` : ""),
      };
    case "run_schedule":
      return { title: `Run schedule ${a.id} now`, detail: "it starts a session straight away" };
    case "mail_rule_put":
      return {
        title: `Add a Gmail filter: ${ruleText(a)}`,
        detail: "it acts on every matching mail from now on, without asking",
      };
    case "mail_rule_delete":
      return {
        title: `Remove the Gmail filter ${ruleText(a.rule)}`,
        detail: "its definition goes with it",
      };
    case "mail_label_delete":
      return {
        title: `Delete the Gmail label ${a.name}`,
        detail: "the mail stays; the label comes off every message and cannot be put back",
      };
    case "calendar_delete":
      return {
        title: `Take off the calendar: ${a.event.summary}`,
        detail: a.every
          ? `every occurrence of the series (the one listed starts ${a.event.start})`
          : `the one starting ${a.event.start}`,
      };
    case "mail_move":
      return {
        title: `Move ${a.uids.length} message${a.uids.length === 1 ? "" : "s"} to ${a.to}`,
        detail: `the server empties that folder on its own\n${a.subjects.join("\n")}`,
      };
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
    case "schedule_put": {
      const id = typeof a.id === "string" ? a.id.slice(0, 100) : undefined;
      // Creating needs enough to be a schedule at all; changing one needs only
      // the thing being changed, and the route it goes through checks the rest.
      if (!id && (typeof a.name !== "string" || typeof a.cron !== "string")) {
        throw new Error("a new schedule needs a name and a cron");
      }
      const num = Number(a.jitterMinutes);
      if (a.jitterMinutes !== undefined && (!Number.isInteger(num) || num < 0 || num > 720)) {
        throw new Error("jitterMinutes must be 0 to 720");
      }
      return {
        kind: "schedule_put",
        ...(id ? { id } : {}),
        ...(typeof a.name === "string" ? { name: a.name.slice(0, 200) } : {}),
        ...(typeof a.project === "string" ? { project: a.project.slice(0, 100) } : {}),
        ...(typeof a.cron === "string" ? { cron: a.cron.slice(0, 100) } : {}),
        ...(typeof a.prompt === "string" ? { prompt: a.prompt.slice(0, 20_000) } : {}),
        ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}),
        ...(a.jitterMinutes === undefined ? {} : { jitterMinutes: num }),
      };
    }
    case "run_schedule":
      return { kind: "run_schedule", id: str("id", 100) };
    case "mail_rule_put": {
      const opt = (k: string, max: number) =>
        typeof a[k] === "string" && a[k].trim() ? { [k]: str(k, max) } : {};
      const rule = {
        ...opt("from", 200),
        ...opt("subject", 200),
        ...opt("query", 500),
        ...opt("label", 200),
        ...(a.archive === true ? { archive: true } : {}),
        ...(a.markRead === true ? { markRead: true } : {}),
      };
      gmail.checkRule(rule);
      return { kind: "mail_rule_put", ...rule };
    }
    // The three below carry something read from the account (`snapshot`), and
    // whatever the caller sent in its place is dropped here.
    case "mail_rule_delete":
      return {
        kind: "mail_rule_delete",
        id: str("id", 200),
        rule: { id: "", archive: false, markRead: false },
      };
    case "mail_label_delete":
      return { kind: "mail_label_delete", name: str("name", 200) };
    case "calendar_delete": {
      const occurrence = typeof a.occurrence === "string" ? a.occurrence.slice(0, 40) : undefined;
      if (occurrence !== undefined && Number.isNaN(Date.parse(occurrence))) {
        throw new Error("occurrence must be a date");
      }
      if (occurrence !== undefined && a.every === true) {
        throw new Error("either one occurrence or every one, not both");
      }
      return {
        kind: "calendar_delete",
        uid: str("uid", 300),
        ...(occurrence ? { occurrence } : {}),
        ...(a.every === true ? { every: true } : {}),
        event: { summary: "", start: "", end: "", location: null },
      };
    }
    case "mail_move": {
      const uids = Array.isArray(a.uids)
        ? [...new Set(a.uids)].filter((u): u is number => Number.isInteger(u) && u > 0)
        : [];
      if (!uids.length || uids.length > mail.MAX_MOVE) {
        throw new Error(`uids must be 1 to ${mail.MAX_MOVE} message uids`);
      }
      const from = typeof a.from === "string" && a.from ? a.from.slice(0, 200) : undefined;
      return {
        kind: "mail_move",
        uids,
        to: str("to", 200),
        ...(from ? { from } : {}),
        subjects: [],
      };
    }
    default:
      throw new Error("unknown kind");
  }
}

/** The caller's mistake, found by asking the account: a 400 with its sentence. */
class Unfileable extends Error {}

/**
 * What the account says about the thing a card names, read as it is filed.
 *
 * A card that says "remove filter ANe1Bmj" authorises nothing a person can
 * judge, and one that shows a description the model wrote authorises the
 * model's description. So the filter, the event and the subjects are read
 * here, from the account. It also means a card that could never run (no such
 * filter, a series with no occurrence named) is refused now, with the
 * sentence that lets the model correct itself, instead of failing on the tap.
 */
async function snapshot(a: ProposalAction): Promise<ProposalAction> {
  switch (a.kind) {
    case "mail_rule_delete": {
      const rule = (await gmail.rules()).find((r) => r.id === a.id);
      if (!rule) throw new Unfileable(`no such filter: ${a.id}`);
      return { ...a, rule };
    }
    case "mail_label_delete":
      if (!(await gmail.labels()).some((l) => l.name === a.name)) {
        throw new Unfileable(`no such label: ${a.name}`);
      }
      return a;
    case "calendar_delete": {
      const { summary, start, end, recurring, location } = await calendar.peek(a.uid, a);
      return {
        ...a,
        event: { summary, start, end, location, ...(recurring ? { recurring } : {}) },
      };
    }
    case "mail_move": {
      const found = await mail.summaries(a.uids, a.from);
      if (!found.length) throw new Unfileable("none of those messages are there");
      return { ...a, subjects: found.map((m) => `${m.from}: ${m.subject}`) };
    }
    default:
      return a;
  }
}

export default async function proposalRoutes(app: FastifyInstance) {
  app.post<{ Body: { action: Record<string, unknown>; why?: string; quiet?: boolean } }>(
    "/api/proposals",
    {
      schema: {
        body: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: {
            action: ACTION,
            why: { type: "string", maxLength: 500 },
            // Filed from a screen the person is looking at, which shows the
            // card itself: no push to a phone to go and find it.
            quiet: { type: "boolean" },
          },
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
      try {
        action = await snapshot(action);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          err instanceof Unfileable ||
          err instanceof mail.MailDenied ||
          err instanceof calendar.CalendarNotFound ||
          err instanceof calendar.CalendarRefused
        ) {
          return reply.code(400).send({ error: message });
        }
        req.log.warn(err, "a proposal could not be read back from the account");
        return reply.code(503).send({ error: message });
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
      if (!req.body.quiet) {
        await announce(
          { title: "tap to decide", body: title.slice(0, 500), url: `/runs#${id}`, tag: "bell" },
          req.log,
        );
      }
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
      // What the tap did, as a line of the assistant's log: the log is where
      // a change is found and put back, and a card's change is one too.
      await toolLog
        .record({
          turn: item.id,
          speaker: "you, by card",
          unattended: false,
          tool: `card:${item.action.kind}`,
          effect: "card",
          args: item.action as unknown as Record<string, unknown>,
          ok: true,
          result: did,
        })
        .catch((err: unknown) => req.log.warn(err, "the tapped card could not be logged"));
      return feed.get(item.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof mail.MailUnavailable ||
        err instanceof calendar.CalendarUnavailable ||
        err instanceof gmail.GmailUnavailable
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
    case "schedule_put": {
      const { kind: _kind, id, ...fields } = a;
      const res = await app.inject(
        id
          ? {
              method: "PATCH",
              url: `/api/schedules/${encodeURIComponent(id)}`,
              payload: fields,
            }
          : { method: "POST", url: "/api/schedules", payload: { ...fields, kind: "session" } },
      );
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      const saved = res.json<{ id: string }>();
      return id ? `changed schedule ${saved.id}` : `created schedule ${saved.id}`;
    }
    case "run_schedule": {
      const res = await app.inject({
        method: "POST",
        url: `/api/schedules/${encodeURIComponent(a.id)}/run`,
      });
      if (res.statusCode >= 300) throw new Error(errorOf(res));
      return `ran schedule ${a.id}`;
    }
    case "mail_rule_put": {
      const { kind: _kind, ...fields } = a;
      return `added filter ${(await gmail.createRule(fields)).id}`;
    }
    case "mail_rule_delete":
      await gmail.deleteRule(a.id);
      return `removed filter ${a.id}`;
    case "mail_label_delete":
      await gmail.deleteLabel(a.name);
      return `deleted label ${a.name}`;
    case "calendar_delete": {
      const gone = await calendar.remove(a.uid, { occurrence: a.occurrence, every: a.every });
      return `removed ${gone.summary}; its file is kept in the calendar trash on the pod`;
    }
    case "mail_move": {
      const moved = await mail.move(a.uids, a.to, { from: a.from, discard: true });
      return `moved ${moved} to ${a.to}`;
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
