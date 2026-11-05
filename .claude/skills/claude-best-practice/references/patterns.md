# Patterns and reference builds

The same rules applied to the systems that come up most. Each decision names the symptom, the fix, and what looks like a fix but is not.

Not date checked. Each decision points at the file that owns the rule, so check the figures there.

## Support agent with tools and handover

1. Account lookup is sometimes skipped and an action lands on the wrong account: a programmatic prerequisite blocks the later tools until the lookup returned a verified id. A prompt or few-shot lowers the rate and never to zero. A routing classifier answers a different problem.
2. The wrong tool is picked from two thinly described ones: expand the descriptions first. A keyword router and merging the tools both cost more.
3. Easy cases escalate and policy exceptions are attempted: explicit escalation criteria with examples in the system prompt. Not a self reported confidence, not a second classifier, not sentiment.

## Multi agent research

4. A report on a broad subject covers one slice: the coordinator split it too narrowly. Subagents that did their task are not the fault.
5. A search subagent times out: return failure type, the query, partial results and alternatives. Not a bare "unavailable", not a silent empty result, not an abort of the run.
6. Synthesis needs fact checks, most of them simple, and every one routed through the coordinator adds latency: give the synthesis agent a scoped `verify_fact` and keep the hard cases going through the coordinator.

## Review and batch pipelines

7. A blocking check and an overnight report are both proposed for the Batches API: batch only the report. A batch has no latency promise, and `custom_id` already pairs request and response.
8. A large input gets inconsistent single pass feedback: a pass per file and one pass across files. Smaller inputs push work to the user, a larger window does not fix attention, and requiring agreement between runs hides real but intermittent findings.
9. A model reviewing its own output in the same conversation rarely questions it. Use a fresh instance with none of the earlier reasoning.

## Extraction

10. Required fields come back invented: make them nullable and add `unclear`. Retrying does not help when the value is not in the source.
11. Totals do not add up: schema validity does not catch it. Extract `calculated_total` beside `stated_total` and flag the difference.
12. 97 percent overall accuracy hides one weak document type: measure by type and field before reducing human review.

## Cost

13. A route is too dear: sweep effort on the current model before changing tier, price the strongest model at low effort before building a cascade, and keep caching healthy throughout. See `models-effort-cost.md`.
14. Cache reads are zero on identical prompts: a per request value sits ahead of the last breakpoint. See `caching.md`.

## Reference builds

Small builds that exercise a whole area. Each should be run, not only written.

15. **Multi tool agent with escalation.** Three or four tools, at least two alike. A `stop_reason` loop. Structured errors with `errorCategory`, `isRetryable` and text. A hook that blocks above a threshold and redirects to escalation. Test messages with several concerns.
16. **Extraction pipeline.** A schema with required, optional, nullable and other plus detail fields; confirm an absent field comes back null. A retry loop that separates fixable errors from information not in the source. Few-shot for varied formats. A batch of 100 documents with `custom_id`, failed ones resubmitted and chunked, and the SLA worked out. Field level confidence routing to review, with accuracy by document type and field.
17. **Multi agent research.** A coordinator that spawns subagents and passes findings in the prompt. Parallel subagent calls with latency measured. Output of claim, evidence excerpt, source and date. A simulated timeout with the gap annotated. A conflicting source case that keeps both values with attribution and separates established from contested.
18. **Effort and cache pass on one route.** Pin effort explicitly, run a sweep over three levels on a frozen sample with a known hard case, record cost per completed task and pass rate, and add a test that asserts cache reads on a second identical request.

## Stack the rules cover

- **Claude API:** Messages, `tool_use`, `tool_choice`, structured outputs (`output_config.format`, strict tools), thinking and effort, streaming, `stop_reason` values including `refusal` and `pause_turn`, `max_tokens`, system prompts, mid conversation system messages, token counting, the Models API.
- **Batches API:** `custom_id`, polling, no multi turn tool calls.
- **Caching, compaction, context editing, memory tool.**
- **Agents:** manual loop, Tool Runner, Managed Agents, Claude Agent SDK, subagents, hooks.
- **MCP:** servers, tools, resources, `isError`, the MCP connector.
- **Server and client tools:** code execution, web search and fetch, tool search, programmatic tool calling, bash, text editor, computer use, advisor.
- **Evals:** building, auditing, hill climbing, cost driven search.
- **Other:** JSON Schema, Pydantic validation and retry, few-shot, prompt chaining, confidence scoring and calibration, stratified sampling.

## Checklist

- [ ] The symptom matches a decision here before a fix is chosen
- [ ] The rule behind the fix is read in its own file, and that file's checklist walked
- [ ] The fix is the cheapest root cause, not the look-alike named as not a fix
- [ ] Each reference build was run, not only written
