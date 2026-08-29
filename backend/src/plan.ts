import fs from "node:fs/promises";
import path from "node:path";
import type { PlanSample, PlanUsage } from "../../shared/api.js";
import { ttlCache } from "./cache.js";
import { env } from "./env.js";
import { agentEnv } from "./settings-store.js";

/**
 * What is left of the subscription, from the account itself.
 *
 * Tokens counted from transcripts say what the bench spent; they cannot say
 * what it may still spend, because the plan's windows are the account's to
 * keep. Claude Code's `/usage` screen reads them from this endpoint with the
 * same OAuth token the sessions run on, and reading it is free — it is the one
 * way to know how much is left without using some to find out.
 *
 * Not a documented API: the shape below is what it returned when this was
 * written, read defensively, and a failure of any kind is null rather than an
 * error. The hub hides the meters; nothing else notices.
 *
 * The account keeps no history of these windows, so the pod keeps one: a
 * sample an hour, appended to one file on the volume. It is the only record of
 * how full the plan got, and — since the windows are the account's — it covers
 * the laptop and claude.ai as much as the sessions here.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

interface Window {
  utilization?: number | null;
  resets_at?: string | null;
}

interface Limit {
  kind?: string;
  percent?: number | null;
  resets_at?: string | null;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

interface Body {
  five_hour?: Window | null;
  seven_day?: Window | null;
  limits?: Limit[] | null;
}

function limit(w: Window | null | undefined): { percent: number; resetsAt: string | null } | null {
  if (!w || typeof w.utilization !== "number") return null;
  return { percent: Math.round(w.utilization), resetsAt: w.resets_at ?? null };
}

/** The wire shape from the account's, or null when it is not one we know. */
export function parsePlan(body: unknown, fetchedAt = new Date().toISOString()): PlanUsage | null {
  const b = body as Body;
  const session = limit(b?.five_hour);
  const week = limit(b?.seven_day);
  if (!session || !week) return null;
  const models = (b.limits ?? [])
    .filter((l) => l.kind === "weekly_scoped" && typeof l.percent === "number")
    .map((l) => ({
      model: l.scope?.model?.display_name ?? "model",
      percent: Math.round(l.percent!),
    }));
  return { session, week, models, fetchedAt, history: [] };
}

async function fetchPlan(): Promise<PlanUsage | null> {
  const token = (await agentEnv()).CLAUDE_CODE_OAUTH_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parsePlan(await res.json());
  } catch {
    return null;
  }
}

/** Cached for a minute: the hub polls, and the windows move by the minute. */
export const planUsage = ttlCache(60_000, fetchPlan);

const historyFile = () => path.join(env.USAGE_DIR, "plan.jsonl");

/** Keep one reading. Appended, so a sample is one line and a crash loses one. */
export async function appendSample(plan: PlanUsage, at = new Date()): Promise<PlanSample> {
  const sample: PlanSample = {
    at: at.toISOString(),
    session: plan.session.percent,
    week: plan.week.percent,
  };
  await fs.mkdir(env.USAGE_DIR, { recursive: true });
  await fs.appendFile(historyFile(), `${JSON.stringify(sample)}\n`);
  return sample;
}

/** The samples since `sinceMs`, oldest first; none when nothing was kept. */
export async function planHistory(sinceMs: number): Promise<PlanSample[]> {
  let raw: string;
  try {
    raw = await fs.readFile(historyFile(), "utf8");
  } catch {
    return [];
  }
  const out: PlanSample[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const s = JSON.parse(line) as PlanSample;
      if (typeof s.at === "string" && Date.parse(s.at) >= sinceMs) out.push(s);
    } catch {
      // A torn line from a crash mid-append: skip it, keep the rest.
    }
  }
  return out;
}

const SAMPLE_EVERY_MS = 60 * 60_000;

/** Take a reading now and every hour after. */
export function startPlanHistory(log: { warn: (obj: unknown, msg?: string) => void }): void {
  const tick = async () => {
    const plan = await planUsage();
    if (plan) await appendSample(plan);
  };
  void tick().catch((err) => log.warn(err, "plan sample failed"));
  setInterval(
    () => void tick().catch((err) => log.warn(err, "plan sample failed")),
    SAMPLE_EVERY_MS,
  )
    // A timer must not be what keeps the process alive.
    .unref();
}
