# Context and reliability

How context, escalation, errors, review and sources are kept reliable.

Not date checked. These are design rules with no per model figures. Check any tool or API name against the `claude-api` skill.

## Keeping context

1. A running summary blurs numbers, percentages, dates and what the user said they expect.
2. A model reads the start and end of a long input well and may drop the middle.
3. Tool results grow out of proportion to use: 40 fields on an order lookup where five matter.
4. Keep transactional facts (amounts, dates, order numbers, statuses) in a case facts block in every prompt, outside the summarized history. A session with several issues keeps each issue's data in its own layer.
5. Trim a tool output to the fields that matter before it accumulates.
6. Put the key findings first in an aggregated input, and give the rest section headers.
7. Make subagents return metadata with their output: dates, where the source is, method.
8. When the next agent's context is tight, the upstream agent returns structured data (facts, citations, relevance scores), not prose and reasoning.

## Escalation and ambiguity

9. Escalate when the user asks for a person, when policy has an exception or a gap (not merely a hard case), or when no progress is possible.
10. A user who asks for a person gets one at once, with no investigation first.
11. A frustrated user who did not ask for a person: acknowledge it and offer a fix if it is within reach. Escalate if they repeat the request.
12. Policy that is silent or unclear escalates. For example, matching a competitor's price when policy covers only the own site.
13. Sentiment and a self reported confidence do not track how hard a case is.
14. More than one record matches: ask for another identifier. Never pick one by a rule of thumb.
15. When the agent escalates easy cases and attempts policy exceptions, put explicit criteria and few-shot examples in the system prompt. A second classifier model is more than it needs.

## Errors across agents

16. An error carries failure type, the query tried, partial results and alternatives.
17. A failed access is not an empty result.
18. Do not return a generic status such as "search unavailable". Do not hide an error as an empty success. Do not stop the whole workflow for one failure.
19. A subagent recovers from a transient failure itself and passes on only what it could not fix.
20. The synthesis marks coverage: which findings are well supported, which topics have a gap because a source was unavailable.

## Large codebases

21. Long sessions drift. Signs are answers that vary and mention "typical patterns" in place of the classes found earlier.
22. A scratchpad file keeps key findings across a context boundary.
23. A subagent takes a narrow question ("find all test files", "trace the payment flow") and returns a summary while the main agent coordinates.
24. Summarize one phase before starting subagents on the next, and inject it.
25. For crash recovery each agent writes its state to a known place. The coordinator loads that manifest on resume and injects it into prompts.
26. When context fills with discovery output, compact it on the server or clear stale tool results with context editing. See `api-tool-use.md`.

## Human review

27. An overall accuracy of 97 percent can hide a weak document type or field.
28. Sample high confidence extractions at random within each stratum to measure error and find new error patterns.
29. Take a confidence per field and set review thresholds on a labelled validation set.
30. Measure accuracy by document type and field before automating or cutting review.
31. Send low confidence, ambiguous and contradictory sources to a person, ordered by the reviewers' capacity.

## Provenance

32. Summarizing loses the link from claim to source. Require structured claim to source mappings (url or document name, the excerpt) and have the synthesis keep and merge them.
33. Two credible sources with different statistics: record both with attribution. Do not pick one. Document analysis keeps both values annotated, and the coordinator reconciles before synthesis.
34. Require a publication or collection date, so a difference in time is not read as a contradiction.
35. Separate well established findings from contested ones and keep how each source described itself and its method.
36. Render by content type: tables for financial data, prose for news, structured lists for technical findings. One format for everything flattens them.

## Checklist

- [ ] Case facts block outside the summary
- [ ] Tool output trimmed
- [ ] Key findings first in long inputs
- [ ] Escalation criteria written, with examples
- [ ] Errors carry type, query, partial results, alternatives
- [ ] Output marks coverage gaps and conflicts with attribution
- [ ] Accuracy known per document type and field before review is reduced
