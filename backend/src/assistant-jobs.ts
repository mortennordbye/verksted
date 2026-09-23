import * as memory from "./memory-store.js";
import * as docs from "./docs.js";
import * as feed from "./feed-store.js";
import * as journal from "./journal-store.js";
import * as loops from "./loops-store.js";
import type { FeedUrgency } from "../../shared/api.js";
import {
  cataloguePrompt,
  journalPrompt,
  learningPrompt,
  triagePrompt,
} from "./assistant-persona.js";
import { runUnattended, saidOn } from "./assistant.js";
import { env } from "./env.js";
import type { Logger } from "./logger.js";
import { announce } from "./notifier.js";
import { readProfile } from "./profile-store.js";
import { readAssistantConfig } from "./settings-store.js";
import { refundCeiling, unattendedBlocked } from "./unattended-budget.js";

/**
 * The assistant's own work, done with nobody reading: the journal, triage of
 * what arrives, the share's catalogue, and what the day's dismissals teach.
 * Out of the scheduler (R-34), which only decides when each runs.
 */

/** Documents catalogued per night: a bounded cost, and a share is read over weeks. */
export const CATALOGUE_PER_NIGHT = 8;
/** How far ahead a date in a document is worth a loop. */
const LOOP_HORIZON_DAYS = 180;
/**
 * The feed's timer: judge what has arrived. Sweeping what is done moved to
 * the daily housekeeping in maintenance.ts, which runs at a fixed hour and on
 * boot, where a 24-hour interval from boot rarely ran at all (R-02).
 *
 * Here rather than in maintenance.ts, which reaps browsers and docker debris
 * and is imported by a route test before that test has set its directories:
 * pulling the scheduler in there made `env` evaluate at import time, and a
 * module that reads a path at import is a module that must not be imported
 * early. Intervals rather than crons, and started once from the bootstrap, so
 * a schedule reload cannot stack a second copy.
 */
export function startFeedWork(log: Logger): void {
  const every = (ms: number, what: string, fn: () => Promise<unknown>) => {
    const timer = setInterval(() => {
      void fn().catch((err: unknown) => log.warn(err, `${what} failed`));
    }, ms);
    timer.unref?.();
  };
  // Triage spaces itself out; this is only how often it is asked whether
  // anything is waiting to be judged.
  every(60_000, "triage", () => runTriage(log));
}

/**
 * Write the day's journal, if anything was said.
 *
 * One cheap turn, on the floor settings from the environment rather than the
 * chair's own, over the day's conversation handed in as text: the turn reads
 * nothing and writes nothing itself, which is what makes it safe to run with
 * nobody watching — and is now the argv rather than a claim, since a turn with
 * a job of its own is spawned with no built-ins, no allow list and an MCP
 * config holding no servers (see `own` in assistant.ts). A day with no
 * conversation costs nothing, and counts against the same ceiling as every
 * other unattended turn.
 */
export async function runJournal(log: Logger, day = journal.today()): Promise<boolean> {
  const said = journal.material(await saidOn(day), day);
  if (!said.trim()) return false;
  const blocked = await unattendedBlocked();
  if (blocked) {
    log.warn({ day }, `journal for ${day} skipped: ${blocked}`);
    return false;
  }
  const { name } = await readAssistantConfig();
  const { text, failed } = await runUnattended(
    said,
    "",
    false,
    {
      model: env.ASSISTANT_MODEL,
      effort: env.ASSISTANT_EFFORT,
      systemPrompt: journalPrompt(name),
    },
    "journal",
  );
  if (failed || !text.trim()) {
    refundCeiling(1);
    log.warn({ day }, `journal for ${day} failed: ${text || "the turn produced nothing"}`);
    return false;
  }
  await journal.writeDay(day, text);
  log.info(`journal written for ${day}`);
  return true;
}

/**
 * One triage verdict, as parsed off a line of the reply.
 *
 * Exported for the test: the grammar is the whole contract with the model, and
 * a line that does not fit is skipped rather than guessed at.
 */
export interface Verdict {
  id: string;
  urgency: FeedUrgency;
  summary: string;
  loop: { slug: string } | { open: string; due: string | null } | null;
}

export function parseVerdicts(text: string): Verdict[] {
  const out: Verdict[] = [];
  for (const raw of text.split("\n")) {
    const parts = raw.split("\t").map((p) => p.trim());
    if (parts.length < 3) continue;
    const [id, urgency = "", summary = "", loop = "-"] = parts;
    if (!id || !["attention", "new", "quiet"].includes(urgency)) continue;
    let ref: Verdict["loop"] = null;
    if (loop.startsWith("new:")) {
      const [what, due = "-"] = loop
        .slice(4)
        .split("|")
        .map((p) => p.trim());
      if (what) ref = { open: what, due: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null };
    } else if (loop && loop !== "-") {
      ref = { slug: loop };
    }
    out.push({ id, urgency: urgency as FeedUrgency, summary, loop: ref });
  }
  return out;
}

/** Not more often than this, so a busy hour is six calls and not sixty. */
const TRIAGE_EVERY_MS = 10 * 60_000;
let lastTriage = 0;

/** Sources whose attention items already reach the phone another way. */
const PUSHES_ITSELF = new Set(["bench", "schedule", "memory"]);

/**
 * Judge what has arrived since the last time: one cheap call over the batch,
 * with the profile and the open loops in front of the model, then the verdicts
 * applied and the attention items pushed once.
 *
 * Nothing here trusts the reply's shape: an id it did not have is ignored, an
 * item it did not mention keeps the poller's verdict and is still marked judged
 * so the next batch does not carry it again, and a bad line is a skipped line.
 */
export async function runTriage(log: Logger, force = false, now = Date.now()): Promise<number> {
  const items = await feed.untriaged();
  if (!items.length) return 0;
  if (!force && now - lastTriage < TRIAGE_EVERY_MS) return 0;
  const blocked = await unattendedBlocked();
  if (blocked) {
    log.warn({}, `triage skipped: ${blocked}`);
    return 0;
  }
  lastTriage = now;
  const [{ name }, profile, open, rules] = await Promise.all([
    readAssistantConfig(),
    readProfile(),
    loops.list(),
    sortingRules(),
  ]);
  const material = items
    .map((i) => `${i.id}\t${i.source}\t${i.title}\t${i.detail.replace(/\s+/g, " ")}`)
    .join("\n");
  const { text, failed } = await runUnattended(
    material,
    "",
    false,
    {
      model: env.ASSISTANT_MODEL,
      effort: env.ASSISTANT_EFFORT,
      systemPrompt: triagePrompt(name, profile, loops.render(open), rules),
    },
    "triage",
  );
  if (failed) {
    refundCeiling(1);
    log.warn({}, `triage failed: ${text || "the turn produced nothing"}`);
    return 0;
  }
  const verdicts = new Map(parseVerdicts(text).map((v) => [v.id, v]));
  let judged = 0;
  for (const item of items) {
    const v = verdicts.get(item.id);
    if (!v) {
      await feed.judge(item.id, { urgency: item.urgency, version: item.version });
      continue;
    }
    let loop: string | null | undefined;
    // An item comes back for judging whenever its version moves on — a PR with
    // a new comment is the same item, later — and the turn cannot see that it
    // already has a loop, so it proposes a second one for the same PR. Six of
    // eleven open loops were that. The attachment the item already carries is
    // the answer, as long as the loop is still open.
    const held = item.loop ? await loops.get(item.loop) : null;
    if (held?.state === "open") {
      loop = held.slug;
    } else if (v.loop && "open" in v.loop) {
      loop = (await loops.open({ what: v.loop.open, due: v.loop.due, from: item.id })).slug;
    } else if (v.loop && "slug" in v.loop) {
      loop = (await loops.get(v.loop.slug)) ? v.loop.slug : undefined;
    }
    const updated = await feed.judge(item.id, {
      urgency: v.urgency,
      detail: v.summary,
      loop,
      version: item.version,
    });
    // Moved on while it was being judged: the next pass reads the new one.
    if (!updated) continue;
    judged++;
    if (
      updated &&
      updated.urgency === "attention" &&
      !updated.pushed &&
      !PUSHES_ITSELF.has(updated.source)
    ) {
      try {
        await announce(
          {
            title: updated.title.slice(0, 100),
            body: updated.detail.slice(0, 500),
            url: updated.link?.startsWith("/") ? updated.link : "/runs",
            tag: "bell",
          },
          log,
        );
        await feed.markPushed(updated.id);
      } catch (err) {
        // A push that cannot go out must not undo the sorting that already
        // happened: the item is judged, it is on the inbox, and the phone is
        // the part that failed. Marked as pushed either way would be a lie,
        // so it stays unpushed and the next attention item tries again.
        log.warn(err, `could not push ${updated.id}`);
      }
    }
  }
  log.info(`triage: ${items.length} item(s) judged, ${judged} by the model`);
  return items.length;
}

/** One catalogue verdict: what a document is, and the dates it names. */
export function parseCatalogue(
  text: string,
): { rel: string; line: string; dates: { on: string; what: string }[] }[] {
  const out: { rel: string; line: string; dates: { on: string; what: string }[] }[] = [];
  for (const raw of text.split("\n")) {
    const [rel, line, dates = "-"] = raw.split("\t").map((p) => p.trim());
    if (!rel || !line) continue;
    const parsed: { on: string; what: string }[] = [];
    for (const part of dates.split(";")) {
      const m = /^(\d{4}-\d{2}-\d{2})\s*(.*)$/.exec(part.trim());
      if (m?.[1]) parsed.push({ on: m[1], what: (m[2] ?? "").trim() || "date" });
    }
    out.push({ rel, line, dates: parsed });
  }
  return out;
}

/**
 * Extract what changed on the share, then catalogue a few documents: one
 * cheap turn over their openings, filed as a line each, with the dates that
 * fall within the horizon opened as loops. A share is read over weeks, a few
 * a night, so the first brief that mentions a renewal from a PDF nobody
 * opened since last year arrives without anyone having paid for the whole
 * share in one go.
 */
export async function runCatalogue(log: Logger, now = Date.now()): Promise<number> {
  if (!(await docs.configured())) return 0;
  const { extracted, skipped } = await docs.sweep();
  if (extracted || skipped) log.info(`docs: ${extracted} extracted, ${skipped} skipped`);
  const batch = await docs.uncatalogued(CATALOGUE_PER_NIGHT);
  if (!batch.length) return 0;
  const blocked = await unattendedBlocked();
  if (blocked) {
    log.warn({}, `catalogue skipped: ${blocked}`);
    return 0;
  }
  const { name } = await readAssistantConfig();
  const material = batch.map((d) => `${d.rel}\n${d.head}\n`).join("\n");
  const { text, failed } = await runUnattended(
    material,
    "",
    false,
    {
      model: env.ASSISTANT_MODEL,
      effort: env.ASSISTANT_EFFORT,
      systemPrompt: cataloguePrompt(name),
    },
    "catalogue",
  );
  if (failed) {
    refundCeiling(1);
    log.warn({}, `catalogue failed: ${text || "the turn produced nothing"}`);
    return 0;
  }
  const known = new Set(batch.map((d) => d.rel));
  const catalogue = await docs.readCatalogue();
  const at = new Date(now).toISOString();
  let filed = 0;
  for (const v of parseCatalogue(text)) {
    if (!known.has(v.rel)) continue;
    catalogue[v.rel] = { line: v.line, dates: v.dates, at };
    filed++;
    for (const d of v.dates) {
      const when = Date.parse(d.on);
      if (Number.isNaN(when) || when < now || when - now > LOOP_HORIZON_DAYS * 86_400_000) continue;
      // The file's name, not its path: the path is in `from`, and a loop that
      // read "start date: documents/Documents/Kontrakt/…" was mostly folders.
      const file = v.rel.split("/").pop() ?? v.rel;
      await loops.open({ what: `${d.what}: ${file}`, due: d.on, from: `doc:${v.rel}` });
    }
  }
  // A document the model said nothing about is filed as unread, so it is not
  // carried into every night's batch; a person can still search its text.
  for (const d of batch) {
    if (!catalogue[d.rel]) catalogue[d.rel] = { line: "(not described)", dates: [], at };
  }
  await docs.writeCatalogue(catalogue);
  log.info(`catalogue: ${filed} of ${batch.length} document(s) described`);
  return filed;
}

/**
 * The rules triage sorts by: the kept preferences, which is where a learned
 * rule lands once the person keeps it. A rule you can read is a rule you can
 * delete, which is the whole reason they are memories rather than weights.
 */
async function sortingRules(): Promise<string> {
  const facts = await memory.list();
  return facts
    .filter((m) => m.type === "preference")
    .map((m) => `- ${m.text.replace(/\s*\n\s*/g, " ")}`)
    .join("\n");
}

/**
 * Learn from what the person did with the day's items: one cheap turn over
 * the day's feed with its states, proposing rules to the review queue. Runs
 * only on a day with a signal, since a day with nothing dismissed teaches
 * nothing, and a proposal costs the person a decision.
 */
export async function runLearning(log: Logger, day = journal.today()): Promise<number> {
  const items = (await feed.list()).filter(
    (i) => journal.dayOf(i.at) === day && i.source !== "proposal" && i.triaged,
  );
  const signal = items.filter(
    (i) => (i.state === "done" && !i.did) || i.state === "snoozed" || i.urgency === "attention",
  );
  if (signal.length < 2) return 0;
  const blocked = await unattendedBlocked();
  if (blocked) {
    log.warn({ day }, `learning for ${day} skipped: ${blocked}`);
    return 0;
  }
  const { name } = await readAssistantConfig();
  const material = items
    .map(
      (i) =>
        `${i.source}\t${i.title}\t${i.urgency}\t${
          i.state === "done" ? (i.did ? `acted: ${i.did}` : "dismissed") : i.state
        }`,
    )
    .join("\n");
  const { text, failed } = await runUnattended(
    material,
    "",
    false,
    {
      model: env.ASSISTANT_MODEL,
      effort: env.ASSISTANT_EFFORT,
      systemPrompt: learningPrompt(name, await sortingRules()),
    },
    "learning",
  );
  if (failed) {
    refundCeiling(1);
    log.warn({ day }, `learning failed: ${text || "the turn produced nothing"}`);
    return 0;
  }
  let proposed = 0;
  for (const raw of text.split("\n")) {
    const [slug, rule] = raw.split("\t").map((p) => p.trim());
    if (!slug || !rule) continue;
    try {
      await memory.propose({
        slug: `sort-${slug
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 40)}`,
        text: rule,
        type: "preference",
        scope: "global",
        source: `learned from what you did with the inbox on ${day}`,
      });
      proposed++;
    } catch {
      // Already remembered, or a bad slug: a proposal not worth a queue entry.
    }
  }
  log.info(`learning: ${proposed} rule(s) proposed for ${day}`);
  return proposed;
}
