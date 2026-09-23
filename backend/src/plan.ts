import fs from "node:fs/promises";
import path from "node:path";
import type { PlanSample, PlanUsage } from "../../shared/api.js";
import { writeTextAtomic } from "./atomic-json.js";
import { ttlCache } from "./cache.js";
import { claudeCredentialsFile } from "./claude-home.js";
import { env } from "./env.js";
import { credential } from "./settings-store.js";

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

/**
 * The token to read the plan with, wherever the pod keeps it: the settings
 * page or the environment first, else the login claude made for itself on the
 * volume — which is how the pod actually signs in, with a token claude renews
 * as sessions run. An expired one is no token; the next session renews it.
 */
export async function oauthToken(now = Date.now()): Promise<string | undefined> {
  const configured = await credential("CLAUDE_CODE_OAUTH_TOKEN");
  if (configured) return configured;
  try {
    const raw = JSON.parse(await fs.readFile(claudeCredentialsFile(), "utf8")) as {
      claudeAiOauth?: { accessToken?: string; expiresAt?: number };
    };
    const login = raw.claudeAiOauth;
    if (!login?.accessToken) return undefined;
    if (typeof login.expiresAt === "number" && login.expiresAt <= now) return undefined;
    return login.accessToken;
  } catch {
    return undefined;
  }
}

/**
 * Why the last read of the plan came back with nothing.
 *
 * Every way this can fail used to end at the same `null`, and the hub answers
 * a null plan by hiding the meters — so a token the account had stopped
 * accepting, an endpoint that had changed shape under an undocumented read,
 * and a pod with no token at all were one silence. On 2026-09-20 the pod had
 * been in that silence long enough that the week-window guard in front of the
 * unattended runs had nothing to read and had quietly stopped guarding.
 *
 * Never the token, never the body: a status and a short reason, which is all
 * that is needed to tell those three apart.
 */
let lastError: string | null = null;

export function planError(): string | null {
  return lastError;
}

/**
 * When it is worth asking again after the account said no.
 *
 * The minute-long memo in front of this means a pod with the hub open asks
 * about fifteen hundred times a day, for ever, and when the answer became
 * "too many requests" it went on asking at exactly that rate. A limit is not
 * something to wait out by knocking: on 2026-09-20 the pod had been sitting
 * on an HTTP 429 with no idea it was making it worse, the meters blank the
 * whole time and the week-window guard in front of the nightly runs reading
 * nothing.
 *
 * Doubling from five minutes to an hour, honouring `Retry-After` when the
 * account names a time itself, and cleared by the first answer that works.
 */
const BACKOFF_MIN_MS = 5 * 60_000;
const BACKOFF_MAX_MS = 60 * 60_000;
let backoffMs = BACKOFF_MIN_MS;
let notBefore = 0;

/** Seconds, or an HTTP date, or nothing: all three become a moment to wait until. */
function retryAfter(header: string | null, now: number): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1_000;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? at : null;
}

/** "in 4 minutes", for a reason a person reads rather than a timestamp. */
function inWords(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes === 1 ? "in a minute" : `in ${minutes} minutes`;
}

// No parameters: ttlCache calls what it memoizes with the cache key, so a
// `now = Date.now()` default would be handed "" and compare as zero — and the
// wait below would never be over.
async function fetchPlan(): Promise<PlanUsage | null> {
  const now = Date.now();
  if (now < notBefore) return null;
  const token = await oauthToken();
  if (!token) {
    lastError = "no token: none on the settings page, and no login on the volume";
    return null;
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 429) {
      // What the account asks for, else the backoff, and the backoff doubles
      // whether or not it was the one used: a limit that keeps being hit wants
      // asking about less often either way.
      const until = retryAfter(res.headers.get("retry-after"), now) ?? now + backoffMs;
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
      notBefore = until;
      lastError = `the account is rate-limiting this read (HTTP 429); trying again ${inWords(until - now)}`;
      return null;
    }
    if (!res.ok) {
      lastError =
        res.status === 401 || res.status === 403
          ? `the account refused the token (HTTP ${res.status}): it has expired or been revoked`
          : `the account answered HTTP ${res.status}`;
      return null;
    }
    const plan = parsePlan(await res.json());
    // A 200 this cannot read is the endpoint having moved, not a credential
    // problem, and the two want opposite things done about them.
    lastError = plan ? null : "the account answered in a shape this cannot read";
    // An answer at all means the limit has cleared, so the next one that does
    // not starts over at five minutes rather than at the hour this climbed to.
    if (plan) backoffMs = BACKOFF_MIN_MS;
    return plan;
  } catch (err) {
    lastError = `could not reach the account: ${err instanceof Error ? err.message : "unknown"}`;
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

/**
 * Drop the samples older than `beforeMs` (R-08): a line an hour is 8760 a year,
 * and the usage page only ever reads the last week. A torn line goes with them.
 */
export async function prunePlanHistory(beforeMs: number): Promise<number> {
  let raw: string;
  try {
    raw = await fs.readFile(historyFile(), "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split("\n").filter(Boolean);
  const kept = lines.filter((line) => {
    try {
      const s = JSON.parse(line) as PlanSample;
      return typeof s.at === "string" && Date.parse(s.at) >= beforeMs;
    } catch {
      return false;
    }
  });
  if (kept.length === lines.length) return 0;
  // An hourly append landing between the read and the rename is lost; one
  // sample a year is not worth a lock.
  await writeTextAtomic(historyFile(), kept.map((l) => `${l}\n`).join(""));
  return lines.length - kept.length;
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
