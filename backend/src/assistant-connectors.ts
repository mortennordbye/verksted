/**
 * The outside services the chair reads through MCP, and which of their tools it
 * may call. Advisors get none of this.
 *
 * Tools are named one by one, because under `--permission-mode dontAsk` a call no
 * allow rule covers is refused before it reaches the server (checked against the
 * real CLI, 2.1.318). A tool a service adds later is refused until it is added
 * here, and a write goes through a card in the app, not through a turn.
 *
 * No imports, so assistant-taint.ts can use it as well as assistant-policy.ts.
 */
export interface Connector {
  id: string;
  /** Tools a turn may call without anyone being asked. */
  reads: string[];
  /** Reads refused outright, because each returns the whole database. */
  denied: string[];
  /** Plain words for a card. */
  label: string;
  /**
   * What a card may ask for. Never on any allow list: a turn can only propose one,
   * and the person's tap is what runs it. Left off on purpose: restoring a whole
   * revision, importing market data, and setting the AI context, which is a line of
   * instructions that a poisoned mail could otherwise ask a person to wave through.
   */
  writes: string[];
}

export const CONNECTORS: Connector[] = [
  {
    id: "headroom",
    reads: [
      "get_assets_and_debts",
      "get_budget_summary",
      "get_debt_analysis",
      "get_employer_cost",
      "get_forecast",
      "get_home_valuation",
      "get_housing",
      "get_mortgage",
      "get_overview",
      "get_pension",
      "get_recommendations",
      "get_salary_and_tax",
      "get_savings_and_goals",
      "get_spending_analysis",
      "get_year_review",
      "list_history",
      "query_transactions",
      "what_if",
    ],
    denied: ["get_raw_data", "get_history_revision"],
    label: "Headroom",
    writes: [
      "add_bonus",
      "add_fixed_expense",
      "add_goal",
      "add_rule",
      "add_salary",
      "add_transaction",
      "delete_debt",
      "delete_fixed_expense",
      "delete_goal",
      "delete_rule",
      "delete_savings_account",
      "delete_transaction",
      "set_category_budget",
      "set_co_owners",
      "set_monthly_income",
      "set_profile",
      "undo_change",
      "update_asset",
      "update_assumptions",
      "update_current_mortgage",
      "update_fixed_expense",
      "update_goal",
      "update_loan",
      "update_transaction",
      "upsert_debt",
      "upsert_savings_account",
    ],
  },
  {
    id: "logeverylift",
    reads: [
      "exercise_history",
      "get_profile",
      "get_program",
      "get_training_cycle",
      "list_programs",
      "list_training_cycles",
      "personal_records",
      "recent_workouts",
      "summary_stats",
      "weekly_volume",
    ],
    denied: [],
    label: "LogEveryLift",
    writes: [
      "create_program",
      "delete_program",
      "edit_cycle_slot",
      "edit_program_exercise",
      "manage_training_cycle",
      "manage_weight",
      "update_profile",
      "update_program",
    ],
  },
];

const named = (c: Connector, tools: string[]) => tools.map((t) => `mcp__${c.id}__${t}`);

/** The allow-list entries for every connector's reads. */
export const CONNECTOR_READS = CONNECTORS.flatMap((c) => named(c, c.reads));
export const CONNECTOR_DENIED = CONNECTORS.flatMap((c) => named(c, c.denied));

const ids = CONNECTORS.map((c) => c.id).join("|");

/** A call into something of the person's that a connector holds. */
export const CONNECTOR_CALL = new RegExp(`^mcp__(${ids})__`);

/** The same, as the CLI's hook matcher wants it. */
export const CONNECTOR_MATCHER = CONNECTORS.map((c) => `mcp__${c.id}__.*`).join("|");
