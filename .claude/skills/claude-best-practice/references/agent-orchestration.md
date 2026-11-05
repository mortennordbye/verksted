# Agents and orchestration

How an agent runs, splits work, and is held to rules.

Agent SDK names (`Agent`, `allowedTools`, `AgentDefinition`, `fork_session`) change between SDK versions. Check them against the current Agent SDK docs.

## The loop

1. Send the request and read `stop_reason`. On `tool_use`, run every requested tool, append the results to the history, and send again. On `end_turn`, stop. Handle the other stop reasons before reading `content`: `refusal` (stop, never run that turn's tools), `max_tokens` (a truncated `tool_use` input is not valid, retry with a higher cap) and `pause_turn` (resume with a cap, `api-tool-use.md` rule 17).
2. The model chooses the next tool from context. A fixed tool sequence or a decision tree written in code is a pipeline, not an agent.
3. Never end the loop by parsing the reply text, by checking that the assistant produced text, or by an iteration cap as the main stop. A cap is a safety net beside `end_turn`.
4. Keep the history append only and pass it on every request. Shrink it with server side compaction or context editing, not by editing earlier turns.

## Coordinator and subagents

5. Hub and spoke. The coordinator decomposes, delegates, aggregates, handles errors and routes. Subagents never talk to each other; everything passes the coordinator, which is what makes it observable and its errors consistent.
6. A subagent has its own context. It does not inherit the coordinator's history and shares no memory with other runs. What it needs goes in its prompt.
7. Spawn with the Agent tool. Include `"Agent"` in `allowedTools` to auto-approve it. The tool was named `Task` before Claude Code v2.1.63 and still shows as `Task` in the `system:init` tools list, so match both names when detecting an invocation.
8. Put complete prior findings in the subagent prompt. Keep content apart from metadata (source url, document name, page) so attribution survives.
9. Parallel subagents come from several Agent calls in one coordinator response, not from separate turns.
10. Write the coordinator prompt as goals and quality criteria, not a step list, so a subagent can adapt.
11. Choose subagents by what the query needs. Do not run the full pipeline every time.
12. Split scope by subtopic or source type so two agents do not do the same work.
13. Refine in a loop: read the synthesis for gaps, re delegate a targeted query, synthesize again, until coverage is enough.
14. `AgentDefinition` carries a subagent type's `description`, `prompt` (its system prompt) and `tools` or `disallowedTools`, plus optional `model` and `effort`. A subagent starts with no parent history, only the Agent tool's prompt string, unless it is a fork.
15. Too narrow a split leaves a broad topic half covered. When a report covers only part of a subject and every subagent did its task, fix the coordinator's decomposition.

## Enforcement

16. Where compliance must hold, block in code. For example, a prerequisite gate stops `process_refund` and `lookup_order` until `get_customer` has returned a verified id. A prompt alone has a failure rate above zero.
17. A PostToolUse hook rewrites a tool result before the model reads it: Unix time and ISO 8601 into one form, numeric status codes into words, across tools from different servers.
18. A tool call hook intercepts the outgoing call: for example, a payment over a limit is blocked and redirected to a human.
19. Use a hook for a business rule that must always hold, a prompt for guidance that may bend.
20. A message with several concerns is split into items, each investigated in parallel on shared context, then answered as one.

## Handoff to a person

21. The person has no transcript. The summary carries the identifiers, root cause, amounts and recommended action for the domain.

## Decomposition

22. A fixed chain (prompt chaining) fits a review whose aspects are known in advance.
23. Open ended work is decomposed as it is discovered: map the structure, find the high impact areas, make a ranked plan, adapt as dependencies appear. Adding tests to a legacy codebase is the example.
24. A large review is a local pass per file and one separate pass across files. One pass over many files dilutes attention and contradicts itself.

## Sessions

25. Resume by loading the stored history and appending to it. In the Agent SDK a named session does this. Resume when the earlier context is mostly still true.
26. Fork to get independent branches from one analysis, for example to compare two test strategies. In the Agent SDK that is `fork_session=True` (Python) or `forkSession: true` (TypeScript): a new session starts with a copy of the original's history and the original is unchanged. At the API level a fork call keeps the cache only if it reuses the parent's exact `system`, `tools` and `model` and appends its own content at the end (`prompt-caching.md` in `claude-api`). Verify cache reads on a fork.
27. When files changed since the session, say which, so the agent re reads those and not everything.
28. When earlier tool results are stale, start a new session and inject a structured summary. That beats resuming on stale results.

## Checklist

- [ ] Loop ends on `end_turn`, and `refusal`, `max_tokens` and `pause_turn` are handled
- [ ] Results appended every turn
- [ ] Compliance order held by a gate or hook
- [ ] `Agent` in the coordinator's `allowedTools`
- [ ] Subagent prompts carry findings and source metadata
- [ ] Independent calls issued in one response
- [ ] Decomposition covers the whole subject
- [ ] Large reviews: a pass per file, then one across files
- [ ] Handoff names the identifiers, root cause, amounts, action
- [ ] Resume or fresh start chosen on whether tool results are stale
