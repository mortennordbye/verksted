# Prompt structure and wording

As of 2026-10-16, from the official prompting best practices page and the `claude-api` prompt audit. Prompts are per model artifacts: re-audit at every model release.

## Layout

1. Long inputs (20K tokens and up) go at the top, above the query, instructions and examples. The query goes at the end. The docs report up to 30 percent better quality from a final query on complex multi document inputs.
2. Wrap each document: `<documents>` around `<document index="n">`, each with `<source>` and `<document_content>`.
3. For a long document task, ask for the relevant quotes first, in their own tag, then the answer in another. It focuses the model on the relevant parts. The prompt audit flags generic scratchpad reasoning as dated. Both hold: quote first to ground a long document, and use thinking with `effort` for reasoning.
4. Use XML tags to separate instructions, context, examples and variable input, with consistent descriptive names, nested where the content is hierarchical. Data goes in a tag, never inline in the instruction.
5. Stable first, volatile last also serves caching. Per request text goes in the newest user turn. See `caching.md`.
6. A single restatement of the few key constraints at the end of a long prompt is fine. Scattered repetition is the anti-pattern.
7. A one sentence role in the system prompt helps. Flag it only when it is the only context given.
8. Give more context than seems necessary. Context is never cruft.
9. The system prompt should not name tools. A preference for tool X belongs in X's own description. The one exception is the replacement for a forced `tool_choice` (`api-behavior.md` rule 10), which names the tool for that turn.

## Where an instruction goes

10. Style instructions hold better in the first user turn than in the system prompt (Fable 5.1 writing density).
11. A batching nudge works better as one sentence near the end of the current request than in the system or a tool description.
12. Mid turn user input goes as a text block after the last `tool_result` in the user message. Never put user text inside a `tool_result`, and never in a mid conversation system message right after a tool result.
13. Harness notices (budget countdowns, reminders) go in a separate mid conversation `role: "system"` message, never in the same block as the user's words.
14. Freeze the top level `system` at session start and append system messages where something changes.

## Examples

15. Examples are one of the most reliable ways to steer format, tone and structure. Use 3 to 5 (2 to 4 for ambiguous cases), relevant, diverse enough to cover edge cases, and wrapped in `<example>` inside `<examples>`.
16. Each example shows why this action and not the plausible other. Show the output format: location, issue, severity, fix. Mark them illustrative so the model does not copy their length and tone.
17. Keep format pinning examples. Prefer a positive example of the length you want over a "don't".
18. With thinking on, present each example as a problem, the method, and the expected answer.

## Wording

19. Be clear and explicit. The test is a colleague with no context: if they would be confused, the model will be. Number the steps when order matters.
20. Give the reason behind an instruction. "It will be read aloud by a text to speech engine, so never use ellipses" generalizes better than "never use ellipses".
21. Say what to do, not what not to do. "Write smoothly flowing prose paragraphs" beats "no markdown". Prompt style bleeds into output style: use structure for reference data and prose for behaviour.
22. Ask for more than the default explicitly if you want it.
23. Prefer outcomes, constraints and verification over step by step scripts for judgment tasks. Keep exact scripts for fragile operations.
24. State scope literally: "apply this formatting to every section, not just the first".
25. Format control: say the shape in positive terms, use a tag to mark a section, match the prompt's own style to the output you want.
26. Chaining draft, review and refine as separate calls is still right when you need to inspect intermediate output or enforce a pipeline.

## Removing what newer models no longer need

27. Newer models follow instructions more closely and literally. Text written for older models can degrade behaviour: over triggering, over planning, rigid answers.
28. Pressure language: `CRITICAL: you MUST` becomes a plain "Use this when...". Delete "be thorough, do not be lazy". Delete "if in doubt, use [tool]", which now over triggers. A stated trigger condition ("call this when the user asks for X") is different and stays (`api-tool-use.md` rule 9). Hedges ("try to", "if possible") are read as permission to under deliver. Emphasis is a tested fix for a demonstrated failure, not a default register.
29. Scaffolds an API feature now does: "think step by step" and `<scratchpad>` become adaptive thinking plus `effort`. Delete "plan before acting". Replace "think harder or less" rules with `effort`. A reasoning field in the output schema can trigger a `reasoning_extraction` refusal, so ask for a short explanation instead. Prefill plus JSON forcing becomes structured output. Lookup tables and arithmetic go to code.
30. Over specification: replace a step script for a judgment task with the outcome. Rewrite prohibition lists as positive intent (a list can anchor the model on the failure). Cut padding and duplicated rules, which make the model reconcile wordings and inflate thinking.
31. Fossils: version workarounds, "minimize tool calls" (Sonnet 5.5 obeys it literally), thinking disabled mitigations, OCR or crop scaffolds for images, "now" and "no longer" phrasing, patch accretion, rules nothing enforces, update suppressors ("don't narrate", "hold all findings"), anti formatting rules (Fable 5.1 already under formats), and instructions re inserted on a turn cadence.
32. Remove only what is wrong for the current model. Removal is a hypothesis: probe behaviour before and after, one change at a time, and re add in minimal form if a cut regresses. Check out of band readers (classifiers, log parsers) before deleting.
33. Keep: context, fragile operation scripts, tool contract detail (often grows), prohibitions against current demonstrated failures, trigger text with calibrated urgency, format pinning examples, working redundancy, a one line role, one end recap. An audit that finds nothing changes nothing.
34. Prompting cost is real: "verify twice" added about 48 percent and "be maximally thorough" about 39 percent to cost on a measured run, because cost follows the extra actions triggered, not prompt length (`evals/cost-hillclimb.md` in `claude-api`).

## Behaviour snippets that exist for current models

35. Concise answers (Opus 5): keep responses focused and brief, caveats short, a high level summary unless depth is asked for. Match document length to the task and do not pad.
36. Outcome first (Fable 5.1): the first sentence answers "what happened". Keep output short by being selective, not by compressing into fragments, abbreviations or arrow chains.
37. Progress updates: remove "hold findings" and "don't narrate" first. Request `display: "updates"` if you want notes. If the harness hides tool output, say that only the model sees it.
38. Parallel calls: measure the share of turns with more than one call, add the nudge only if it is low, and append it fresh each turn, leaving earlier copies in place.
39. Autonomy: for reversible actions that follow from the request, proceed without asking. Stop only for destructive actions or scope changes the user must decide. A question is a deliverable, so answer it and stop.
40. Scope and tests: do not fix or extend adjacent code, report it as a follow up. Commit tests only where the task or repo convention asks. Keep scratch checks out of the repo. Edit surgically instead of rewriting a file.
41. Progress claims: audit each claim against a tool result from this session. Say what failed, what was skipped, and state what is done and verified plainly.
42. Context anxiety (Fable 5.1): avoid showing remaining token counts. If shown, say there is ample context and not to stop on account of it.
43. Early stopping in long agent prompts at low effort (Haiku 5.5): keep working until everything asked is done, stop only when blocked or before a risky step, then stop and report without adding unrequested features.
44. Code review prompts: do not filter by severity or confidence at the finding stage, since that depresses recall. Report everything with confidence and severity so a later step ranks it.
45. Verification on low effort coding agents: run a real check that exercises the change before reporting done. A syntax only check or one that failed to start does not count. On Opus 5 carried over "double check" text causes over verification, so delete it there.
46. Frontend design on Opus 5.5: name the specific defaults to avoid. A vague "avoid generic AI look" is the failure.
47. Subagents on Opus 5: it delegates readily, so remove "delegate more", cap parallel agents, and keep verification in the main loop.

## Grounding and consistency

48. Ground long document answers in quotes. Investigate before answering: never speculate about code you have not opened.
49. Self check before finishing ("verify against these criteria") catches errors in code and math, except on Opus 5.
50. Use structured outputs or strict tools for schema consistency. For classification use an enum tool or structured output.
51. The sources do not give a rule for an explicit "say you do not know" instruction, for prompt injection defences, or for temperature. Do not invent one. Untrusted text goes in a data tag and is treated as data, which is a design rule from rule 4 and the tool security guidance, not a documented guarantee.

## Checklist

- [ ] Long inputs first, query last, each document tagged with its source
- [ ] Instructions, data and examples in separate tags
- [ ] 3 to 5 varied examples on ambiguous cases
- [ ] Positive instructions with reasons
- [ ] No scaffolds an API feature now provides
- [ ] No pressure language or hedges nothing demonstrated needed
- [ ] Tool preferences live in tool descriptions
- [ ] Prompt re audited for the current model
