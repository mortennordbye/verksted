import type { AssistantCard } from "../../shared/api.js";

/**
 * A picture of what a tool returned, for the few tools worth one.
 *
 * Built from the tool's own result, never from what the model wrote, and only from
 * fields named here and checked for type: a result is text a server sent, and what
 * reaches the screen is what this picks out of it. Anything that does not fit gives
 * no card, and the reply is the same either way.
 */
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (v: unknown, max = 40): string | null =>
  typeof v === "string" && v.length <= max ? v : null;

function budget(data: Record<string, unknown>): AssistantCard | null {
  const income = num(data.monthlyNetIncome);
  const fixed = num(data.totalFixedExpenses);
  const saved = num(data.monthlySavings);
  const month = short(data.monthKey, 10);
  if (income === null || fixed === null || saved === null || !month) return null;
  const rate = short(data.savingsRate, 30);
  return { kind: "budget", month, income, fixed, saved, ...(rate ? { rate } : {}) };
}

function volume(data: Record<string, unknown>): AssistantCard | null {
  if (!Array.isArray(data.weeks)) return null;
  const weeks = (data.weeks as Record<string, unknown>[])
    .map((w) => ({
      weekStart: short(w?.weekStart, 10),
      volumeKg: num(w?.volumeKg),
      sessions: num(w?.sessions),
    }))
    .filter(
      (w): w is { weekStart: string; volumeKg: number; sessions: number } =>
        w.weekStart !== null && w.volumeKg !== null && w.sessions !== null,
    )
    .slice(-52);
  return weeks.length ? { kind: "volume", weeks } : null;
}

/** How many categories a spending card shows: the rest are the long tail. */
const TOP_CATEGORIES = 6;

function spending(data: Record<string, unknown>): AssistantCard | null {
  const month = short(data.monthKey, 10);
  if (!month || !Array.isArray(data.byCategory)) return null;
  const budgets = new Map<string, number>();
  for (const b of Array.isArray(data.budgetProgress)
    ? (data.budgetProgress as Record<string, unknown>[])
    : []) {
    const category = short(b?.category);
    const budget = num(b?.budget);
    if (category && budget !== null) budgets.set(category, budget);
  }
  const categories = (data.byCategory as Record<string, unknown>[])
    .map((c) => ({ category: short(c?.category), amount: num(c?.amount) }))
    .filter((c): c is { category: string; amount: number } => !!c.category && c.amount !== null)
    .slice(0, TOP_CATEGORIES)
    .map((c) => {
      const budget = budgets.get(c.category);
      return budget === undefined ? c : { ...c, budget };
    });
  return categories.length ? { kind: "spending", month, categories } : null;
}

const BUILDERS: Record<string, (data: Record<string, unknown>) => AssistantCard | null> = {
  mcp__headroom__get_budget_summary: budget,
  mcp__headroom__get_spending_analysis: spending,
  mcp__logeverylift__weekly_volume: volume,
};

export function cardFor(tool: string, result: string): AssistantCard | undefined {
  const build = BUILDERS[tool];
  if (!build) return undefined;
  try {
    const data: unknown = JSON.parse(result);
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    return build(data as Record<string, unknown>) ?? undefined;
  } catch {
    return undefined;
  }
}
