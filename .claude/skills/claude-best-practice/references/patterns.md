# Patterns and reference builds

The same rules applied to the systems that come up most. Each decision names the symptom, the fix, and what looks like a fix but is not.

Not date checked. Each decision points at the file that owns the rule, so check the figures there.

## Support agent with tools and handover

1. Account lookup is sometimes skipped and an action lands on the wrong account: a programmatic prerequisite blocks the later tools until the lookup returned a verified id. A prompt or few-shot lowers the rate and never to zero. A routing classifier answers a different problem. A hook alone is not it either unless it fails closed and covers the Bash path (`agent-orchestration.md` rule 23).
2. The wrong tool is picked from two thinly described ones: expand the descriptions first, then `input_examples`. A keyword router and merging the tools both cost more.
3. Easy cases escalate and policy exceptions are attempted: explicit escalation criteria with examples in the system prompt. Not a self reported confidence, not a second classifier, not sentiment.

## Multi agent research

4. A report on a broad subject covers one slice: the coordinator split it too narrowly. Subagents that did their task are not the fault.
5. A search subagent times out: return failure type, the query, partial results and alternatives. Not a bare "unavailable", not a silent empty result, not an abort of the run.
6. Synthesis needs fact checks, most of them simple, and every one routed through the coordinator adds latency: give the synthesis agent a scoped `verify_fact` and keep the hard cases going through the coordinator.
7. The coordinator's context fills with relayed subagent text: subagents write their output to the shared store and return a reference plus a short structured summary (`agent-orchestration.md` rule 11). Not a bigger window, not a cheaper coordinator model.
8. A coding task is proposed as a team of agents: one conversation. The phases share context, and multi agent costs about 15 times chat tokens (`agent-orchestration.md` rule 5). Not a fork per file.

## Agent loops

9. The UI goes silent for the whole tool loop on Opus 5.5 or Sonnet 5.5: the model's between call text now arrives as progress thinking blocks, empty by default. Render `display: "updates"` or `"summarized"` (`api-behavior.md` rule 9). Not a "narrate your progress" prompt line.
10. A long loop gets slower to first token every turn: a message thread (`api-tool-use.md` rules 38 to 42). Not a smaller `max_tokens`, and not a cost fix, because the price is unchanged.
11. The conversation nears the window: on demand compaction with a trigger the app computes from `usage` (`api-tool-use.md` rule 33). Not client side keep tail compaction, which breaks preserved thinking; not context editing as a saving.
12. A 400 "bound to a different conversation" appears after a prefix edit: run the three step check and replace the edit with its append only form (`api-behavior.md` rules 29 and 30). Not a standing `drop_block`.

## Review and batch pipelines

13. A blocking check and an overnight report are both proposed for the Batches API: batch only the report. A batch has no latency promise, and `custom_id` already pairs request and response.
14. A large input gets inconsistent single pass feedback: a pass per file and one pass across files. Smaller inputs push work to the user, a larger window does not fix attention, and requiring agreement between runs hides real but intermittent findings.
15. A model reviewing its own output in the same conversation rarely questions it. Use a fresh instance with none of the earlier reasoning.

## Extraction

16. Required fields come back invented: make them nullable and add `unclear`. Retrying does not help when the value is not in the source.
17. Totals do not add up: schema validity does not catch it. Extract `calculated_total` beside `stated_total` and flag the difference.
18. 97 percent overall accuracy hides one weak document type: measure by type and field before reducing human review.

## Cost

19. A route is too dear: sweep effort on the current model before changing tier, price the strongest model at low effort before building a cascade, and keep caching healthy throughout. See `models-effort-cost.md`.
20. Cache reads are zero on identical prompts: a per request value sits ahead of the last breakpoint. See `caching.md`.
21. Cache reads drop to zero once, mid conversation: the TTL, the model, the tools or the effort changed inside the conversation (`caching.md` rule 28). Not a cache outage.
22. A long Haiku 5.5 loop costs more than the Sonnet one: its second rate card past 100K prompt tokens, cache reads included (`models-effort-cost.md` rule 26).

## Reference builds

Small builds that exercise a whole area. Each should be run, not only written.

23. **Multi tool agent with escalation.** Three or four tools, at least two alike. The Tool Runner loop with a `stop_reason` branch for `refusal` and `pause_turn`. Structured errors with class, retryability and text. A fail closed `PreToolUse` hook that blocks above a threshold and redirects to escalation, plus a test that the Bash path is blocked too. Test messages with several concerns.
24. **Extraction pipeline.** A schema with required, optional, nullable and other plus detail fields; confirm an absent field comes back null. A retry loop that separates fixable errors from information not in the source. Few-shot for varied formats. A batch of 100 documents with `custom_id`, a 1h cache warmed first, failed ones resubmitted and chunked, and the SLA worked out. Field level confidence routing to review, with accuracy by document type and field.
25. **Multi agent research.** A coordinator that spawns subagents and passes findings in the prompt, with a spend cap. Parallel subagent calls with latency measured. Output of claim, evidence excerpt, source and date. A simulated timeout with the gap annotated. A conflicting source case that keeps both values with attribution and separates established from contested.
26. **Long loop with a thread and compaction.** One agent on a message thread, compaction on demand at an app chosen trigger, a replay path exercised by forcing `thread_not_found`, preserved thinking checked with `"error"` in the test and `input_transformations` logged.
27. **Effort and cache pass on one route.** Pin effort explicitly, run a sweep over three levels on a frozen sample with a known hard case, confirm the dial moves `thinking_tokens`, record cost per completed task and pass rate from the second request on, and add a test that asserts cache reads on a second identical request.

## Stack the rules cover

- **Claude API:** Messages, the API version header, `tool_use`, `tool_choice`, structured outputs (`output_config.format`, strict tools), thinking and effort, streaming, `stop_reason` values including `refusal`, `pause_turn` and `compaction`, `max_tokens`, system prompts, mid conversation system messages, per message effort, token counting, the Models API.
- **Batches API:** `custom_id`, polling, server tools inside a batch, no client tool loop.
- **Caching, message threads, compaction (on demand and threshold), context editing, memory tool.**
- **Agents:** manual loop, Tool Runner, Managed Agents (permission policies, vaults, outcomes), Claude Agent SDK, subagents, fork subagents, agent teams, hooks.
- **MCP:** servers, tools, resources, `isError` and protocol errors, `structuredContent`, the MCP connector.
- **Server and client tools:** code execution, web search and fetch, tool search, programmatic tool calling, bash, text editor, computer toolset, advisor.
- **Evals:** building, auditing, hill climbing, cost driven search.
- **Measuring:** usage and cost reports, OpenTelemetry spans.
- **Other:** JSON Schema, Pydantic validation and retry, few-shot, prompt chaining, confidence scoring and calibration, stratified sampling.

## Checklist

- [ ] The symptom matches a decision here before a fix is chosen
- [ ] The rule behind the fix is read in its own file, and that file's checklist walked
- [ ] The fix is the cheapest root cause, not the look-alike named as not a fix
- [ ] Each reference build was run, not only written
