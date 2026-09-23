import * as journal from "./journal-store.js";
import { planUsage } from "./plan.js";

/**
 * What every unattended turn is counted against: a daily backstop and the
 * subscription's own week. Out of the scheduler (R-34), which starts the runs;
 * the assistant's own jobs spend from the same two.
 */

/**
 * How many unattended assistant turns may start in one day, across every
 * schedule.
 *
 * The session ceiling above does not bind these: a briefing holds no tmux and
 * no working tree, so nothing else would notice a schedule set to `* * * * *`
 * quietly making 1440 model calls a day against a subscription. This is the
 * backstop for that — not a budget for normal use, which is three or four.
 *
 * In memory, and reset by a restart. That is the right trade for a backstop:
 * the failure it guards against is a runaway loop within one day, and a file on
 * the volume to survive a reboot would be state kept for nothing.
 *
 * Sixty rather than twelve since triage joined: a busy day is twenty or thirty
 * small triage calls, and a ceiling that bit on an ordinary Tuesday would be a
 * budget rather than a backstop. Triage is bounded by its own ten-minute
 * spacing; this is what stops everything else.
 */
export const MAX_UNATTENDED_PER_DAY = 60;
let unattendedDay = "";
let unattendedToday = 0;

/**
 * True when today's ceiling is already spent; counts the turns when it is not.
 *
 * Turns rather than runs, because a briefing that convenes the council is
 * several model calls wearing one schedule's name. A ceiling that counted runs
 * would let twelve meetings be forty-eight calls, and a backstop that stops
 * counting the thing it is backstopping is worse than none.
 *
 * `n` is what the run is about to spend at most: one for a solo briefing, and
 * for a meeting the chair's two turns plus everyone it might convene. Reserved
 * up front rather than charged as it goes, because a meeting that runs out
 * halfway has already spent the expensive half and has nothing to show for it.
 */
export function overDailyCeiling(n = 1): boolean {
  // The bench's own day, not UTC (R-15): a ceiling keyed on the UTC date reset
  // at 01:00 or 02:00 Oslo time, in the middle of the night these runs happen
  // in, so the small hours were charged to the day that was ending and the
  // backstop covered two halves of two days rather than one day.
  const day = journal.today();
  if (day !== unattendedDay) {
    unattendedDay = day;
    unattendedToday = 0;
  }
  if (unattendedToday + n > MAX_UNATTENDED_PER_DAY) return true;
  unattendedToday += n;
  return false;
}

/**
 * Hand back what a meeting did not spend.
 *
 * The reservation is for the worst case — the chair may convene nobody, or
 * fewer than the roster — and a budget that only ever went down would make a
 * quiet morning cost as much as a busy one.
 */
export function refundCeiling(n: number): void {
  unattendedToday = Math.max(0, unattendedToday - n);
}

/**
 * How full the week's window may be before the clock stops spending it.
 *
 * The ceiling above counts what this process started, which says nothing about
 * the account it is spent against: the same subscription serves the laptop and
 * claude.ai. At 95% a night's work is borrowed from the person's own morning,
 * and the stage that starts anyway meets the wall mid-run.
 */
const PLAN_WEEK_LIMIT = 95;

/**
 * The subscription's own answer, as a refusal or null (R-15).
 *
 * Not being able to read it is not a refusal. The endpoint is undocumented and
 * `planUsage` already answers null for anything it does not recognise, so a
 * bench that stopped running its nights whenever a lookup failed would fail
 * far more often, and for the wrong reason.
 */
export async function planSpent(): Promise<string | null> {
  const plan = await planUsage().catch(() => null);
  if (!plan || plan.week.percent < PLAN_WEEK_LIMIT) return null;
  return `the week's plan window is ${plan.week.percent}% spent`;
}

/**
 * Both guards in front of a turn nobody asked for: what is left of the week,
 * and what this day has already started. Reserves the ceiling when it answers
 * null, exactly as `overDailyCeiling` does on its own.
 */
export async function unattendedBlocked(n = 1): Promise<string | null> {
  const spent = await planSpent();
  if (spent) return spent;
  if (overDailyCeiling(n)) return `${MAX_UNATTENDED_PER_DAY} unattended turns already ran today`;
  return null;
}
