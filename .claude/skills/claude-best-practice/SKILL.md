---
name: claude-best-practice
description: How to put Claude inside an application. Use when designing, building or reviewing a feature that calls the Claude API or Agent SDK: an agent loop, a coordinator with subagents, tools and MCP and their errors, choosing effort and model tier, prompt layout and caching, structured extraction with a JSON schema, a Batches job, refusal and error handling, history and thinking blocks, escalation, auditing or migrating an existing prompt for a newer model, or how to evaluate any of it. Model ids, parameters and SDK syntax are the claude-api skill.
---

This is the decision rules for building Claude into an app, not the API reference. Where it and `CLAUDE.md`, `.claude/rules/` or another skill disagree, the repo wins. Pick the row, read that file, then walk its checklist before calling the design done. A task that touches several rows walks each row's checklist.

| Concern | File |
|---|---|
| Agent loop, coordinator, subagents, hooks, handoff, state | `references/agent-orchestration.md` |
| Tool descriptions, tool errors, scoping, MCP | `references/tools-mcp.md` |
| Which surface, tool mechanics, server tools, structured output | `references/api-tool-use.md` |
| Thinking, forced tool choice, prefill, refusals, history, errors | `references/api-behavior.md` |
| Effort, model tier, cost levers, measuring | `references/models-effort-cost.md` |
| Cache placement, TTL, invalidators, verifying | `references/caching.md` |
| Prompt layout, wording, removing dated text, behaviour snippets | `references/prompt-structure.md` |
| Review criteria, few-shot, schema output, retry, Batches | `references/prompts-output.md` |
| Context, escalation, error propagation, human review, provenance | `references/context-reliability.md` |
| Building, auditing and hill climbing an eval | `references/evals.md` |
| Worked decisions and reference builds | `references/patterns.md` |

## Rules that hold everywhere

1. A rule with financial or compliance weight is enforced in code, a hook or a prerequisite gate. A prompt or a few-shot example is probabilistic and never the only guard.
2. Fix the cheapest root cause first. A better tool description or an explicit criterion comes before a classifier, a routing layer or a new service.
3. Bad coverage in a multi agent result is the coordinator's decomposition until shown otherwise. A subagent that did what it was told is not the fault.
4. Give each agent the few tools its role needs. Four or five beats eighteen.
5. Errors, handoffs, findings and extractions are structured. Never "operation failed", never an empty result that means a failure.
6. Whoever wrote the work does not review it. An independent instance reviews, per file first and then across files.
7. Blocking work is a synchronous call. Only work that can wait a day goes to the Batches API.
8. Escalate on stated criteria with examples. Sentiment and a self reported confidence number are not a measure of difficulty.
9. A number, date, id or amount that matters is carried as a field outside any summary, with its source.
10. Judge cost per completed task. Sweep effort on the current model before changing tier, and price the strongest model at lower effort before building a cascade.
11. Put stable content first and per request content last. Long inputs go above the question, and the question goes last.
12. Keep conversation history append only. Never edit the prefix, the tools or the model inside a conversation.
13. Nothing is tuned by feel. Every change to a prompt, effort, model or cost lever is kept or reverted on an eval.
14. Read `stop_reason` before `content`. Handle `refusal`, `max_tokens` and `pause_turn`.

## Basis and revision

The agent, tool, prompt and context rules are drawn from Anthropic's Claude Certified Architect Foundations guide, v1.0, July 2026, reduced to practice. Nothing about the certification itself is carried here. Effort, model choice, caching, request behaviour, tool mechanics and evals are drawn from the `claude-api` skill (models cached 2026-10-06) and Anthropic's published docs. Last revised 2026-10-16. Files that carry an "As of" date near the top (`api-tool-use.md`, `api-behavior.md`, `caching.md`, `models-effort-cost.md`, `prompt-structure.md`, `evals.md`) were checked against the docs on that date. The others are design rules, except a few model or version specific items that are not date checked: the Batches terms in `prompts-output.md` and the Claude Code version in `agent-orchestration.md`. `tools-mcp.md` and `prompts-output.md` point to `api-behavior.md` for which models reject forced `tool_choice`.

Model ids, per model defaults, beta names, minimums and platform support change every release. Each reference says what to check. Check the current docs before depending on one, and update the revision date when a file is checked against them.

## Not covered

Fine tuning, API auth and billing, hosting an MCP server, model internals, embeddings, vision details, rate limit tables, price lists (`models-effort-cost.md` holds one worked cost per task example, not a price list), key rotation, cloud setup, benchmarking, tokenization internals, and Claude Code configuration beyond the Agent SDK names in `agent-orchestration.md` and the MCP config rule in `tools-mcp.md`.
