import { describe, expect, it } from "vitest";
import { toolLabel } from "../src/components/chat/toolLabel";

describe("what a tool is called on screen", () => {
  it.each([
    ["WebFetch", "read a page"],
    ["convene", "asked"],
    ["compacted", "summarised earlier"],
    ["mcp__headroom__get_budget_summary", "finances: budget summary"],
    ["mcp__logeverylift__recent_workouts", "training: recent workouts"],
    ["mcp__browser__browser_navigate", "browser: navigate"],
    ["mcp__verksted__mail_search", "mail search"],
    ["mcp__verksted__list_prs", "prs"],
    ["mcp__somewhere__do_a_thing", "somewhere: do a thing"],
    ["SomethingNew", "SomethingNew"],
  ])("%s reads as %s", (name, label) => {
    expect(toolLabel(name)).toBe(label);
  });
});
