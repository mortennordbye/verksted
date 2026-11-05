import { describe, expect, it } from "vitest";
import { cardFor } from "../src/assistant-cards.js";
import { consumeChunk, newStreamState } from "../src/assistant-stream.js";

const BUDGET = {
  monthKey: "2026-11",
  monthlyNetIncome: 52_000,
  totalFixedExpenses: 31_000,
  monthlySavings: 8_000,
  savingsRate: "on track",
  cashflowLast12: [{ anything: "else" }],
};

describe("a card from a tool's result", () => {
  it("takes the named figures from a budget summary and nothing else", () => {
    expect(cardFor("mcp__headroom__get_budget_summary", JSON.stringify(BUDGET))).toEqual({
      kind: "budget",
      month: "2026-11",
      income: 52_000,
      fixed: 31_000,
      saved: 8_000,
      rate: "on track",
    });
  });

  it("gives no card when a figure is not a number", () => {
    const wrong = { ...BUDGET, monthlyNetIncome: "52000; <script>" };

    expect(cardFor("mcp__headroom__get_budget_summary", JSON.stringify(wrong))).toBeUndefined();
  });

  it("keeps only well-formed weeks of volume", () => {
    const card = cardFor(
      "mcp__logeverylift__weekly_volume",
      JSON.stringify({
        weeks: [
          { weekStart: "2026-10-27", sessions: 3, volumeKg: 12_400 },
          { weekStart: "2026-11-03", sessions: "three", volumeKg: 9_000 },
        ],
      }),
    );

    expect(card).toEqual({
      kind: "volume",
      weeks: [{ weekStart: "2026-10-27", sessions: 3, volumeKg: 12_400 }],
    });
  });

  it("takes the top categories of a spending analysis, with a budget where one is set", () => {
    const card = cardFor(
      "mcp__headroom__get_spending_analysis",
      JSON.stringify({
        monthKey: "2026-11",
        byCategory: [
          { category: "groceries", amount: 6200 },
          { category: "transport", amount: 1800 },
          { category: 42, amount: 5 },
        ],
        budgetProgress: [
          { category: "groceries", budget: 7000, spent: 6200, pct: 88, over: false },
        ],
        recurringUntracked: [{ merchant: "not wanted here" }],
      }),
    );

    expect(card).toEqual({
      kind: "spending",
      month: "2026-11",
      categories: [
        { category: "groceries", amount: 6200, budget: 7000 },
        { category: "transport", amount: 1800 },
      ],
    });
  });

  it("draws nothing for a tool it does not know, or a result that is not JSON", () => {
    expect(cardFor("mcp__headroom__get_raw_data", JSON.stringify(BUDGET))).toBeUndefined();
    expect(cardFor("mcp__headroom__get_budget_summary", "Error: asleep")).toBeUndefined();
  });

  it("is put on the call that returned it, from text blocks as the CLI sends them", () => {
    const state = newStreamState();
    const line = (e: unknown) => `${JSON.stringify(e)}\n`;
    consumeChunk(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "mcp__headroom__get_budget_summary", input: {} },
          ],
        },
      }),
      state,
    );
    consumeChunk(
      line({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: JSON.stringify(BUDGET) }],
            },
          ],
        },
      }),
      state,
    );

    const [entry] = consumeChunk(
      line({ type: "assistant", message: { content: [{ type: "text", text: "Here it is." }] } }),
      state,
    );

    expect(entry.tools[0].card).toMatchObject({ kind: "budget", saved: 8_000 });
  });
});
