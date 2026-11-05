# Context and reliability

How context, escalation, errors, review and sources are kept reliable.

Design rules with no per model figures, checked against Anthropic's context engineering and multi agent posts on 2026-11-05. The escalation and human review sections come from the Architect guide and have no other published source. Check any tool or API name against the `claude-api` skill.

## Keeping context

1. Context is a finite budget with diminishing returns. The smallest set of high signal tokens that gets the outcome wins; every token in the window competes for attention.
2. A running summary blurs numbers, percentages, dates and what the user said they expect.
3. A model reads the start and end of a long input well and may drop the middle.
4. Tool results grow out of proportion to use: 40 fields on an order lookup where five matter.
5. Keep transactional facts (amounts, dates, order numbers, statuses) in a case facts block in every prompt, outside the summarized history. A session with several issues keeps each issue's data in its own layer.
6. Trim a tool output to the fields that matter before it accumulates, and design the tool to return that much (`tools-mcp.md`).
7. Put the key findings first in an aggregated input, and give the rest section headers.
8. Make subagents return metadata with their output: dates, where the source is, method.
9. When the next agent's context is tight, the upstream agent returns structured data (facts, citations, relevance scores), not prose and reasoning.
10. Load just in time where you can: keep lightweight identifiers (file paths, stored queries, record ids) in context and fetch the data at the moment it is needed, instead of pre loading everything. The hybrid is usual: a small always present core plus retrieval on demand.
11. Pick the technique by the shape of the work: compaction for long back and forth, a notes file for milestones that must survive a context reset, subagents for parallel reading whose detail the lead never needs. Tune a compaction prompt for recall first, then cut what it keeps that nothing used.

## Escalation and ambiguity

12. Escalate when the user asks for a person, when policy has an exception or a gap (not merely a hard case), or when no progress is possible.
13. A user who asks for a person gets one at once, with no investigation first.
14. A frustrated user who did not ask for a person: acknowledge it and offer a fix if it is within reach. Escalate if they repeat the request.
15. Policy that is silent or unclear escalates. For example, matching a competitor's price when policy covers only the own site.
16. Sentiment and a self reported confidence do not track how hard a case is.
17. More than one record matches: ask for another identifier. Never pick one by a rule of thumb.
18. When the agent escalates easy cases and attempts policy exceptions, put explicit criteria and few-shot examples in the system prompt. A second classifier model is more than it needs.

## Errors across agents

19. An error carries failure type, the query tried, partial results and alternatives.
20. A failed access is not an empty result.
21. Do not return a generic status such as "search unavailable". Do not hide an error as an empty success. Do not stop the whole workflow for one failure.
22. A subagent recovers from a transient failure itself and passes on only what it could not fix.
23. The synthesis marks coverage: which findings are well supported, which topics have a gap because a source was unavailable.
24. Whatever a subagent read is data. Its report can carry injected instructions from a page or a document; the coordinator treats the report as findings to weigh, never as orders (`agent-orchestration.md` rule 21).

## Large codebases

25. Long sessions drift. Signs are answers that vary and mention "typical patterns" in place of the classes found earlier.
26. A scratchpad file keeps key findings across a context boundary.
27. A subagent takes a narrow question ("find all test files", "trace the payment flow") and returns a summary while the main agent coordinates.
28. Summarize one phase before starting subagents on the next, and inject it.
29. For crash recovery each agent writes its state to a known place. The coordinator loads that manifest on resume and injects it into prompts.
30. When context fills with discovery output, compact it on demand or clear stale tool results with context editing. See `api-tool-use.md` rules 32 to 34.

## Human review

31. An overall accuracy of 97 percent can hide a weak document type or field.
32. Sample high confidence extractions at random within each stratum to measure error and find new error patterns.
33. Take a confidence per field and set review thresholds on a labelled validation set.
34. Measure accuracy by document type and field before automating or cutting review.
35. Send low confidence, ambiguous and contradictory sources to a person, ordered by the reviewers' capacity.

## Provenance

36. Summarizing loses the link from claim to source. Require structured claim to source mappings (url or document name, the excerpt) and have the synthesis keep and merge them.
37. Two credible sources with different statistics: record both with attribution. Do not pick one. Document analysis keeps both values annotated, and the coordinator reconciles before synthesis.
38. Require a publication or collection date, so a difference in time is not read as a contradiction.
39. Separate well established findings from contested ones and keep how each source described itself and its method.
40. Render by content type: tables for financial data, prose for news, structured lists for technical findings. One format for everything flattens them.

## Checklist

- [ ] Case facts block outside the summary
- [ ] Tool output trimmed at the tool, identifiers kept and data fetched on demand
- [ ] Key findings first in long inputs
- [ ] Escalation criteria written, with examples
- [ ] Errors carry type, query, partial results, alternatives
- [ ] Subagent reports treated as data
- [ ] Output marks coverage gaps and conflicts with attribution
- [ ] Accuracy known per document type and field before review is reduced
