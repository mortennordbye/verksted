# Prompts and structured output

How review criteria, examples, schemas, retries and batches are set.

Design rules. The Batches facts were checked against the live batch processing page on 2026-11-05; before relying on a limit, check `claude-api` and the current docs.

## Criteria

1. A categorical criterion beats a vague one. "Flag a comment only when what it claims contradicts what the code does" works. "Check that comments are accurate" does not.
2. "Be conservative" and "report only high confidence findings" do not raise precision.
3. Many false positives cost trust in the categories that are right.
4. State what to report (bugs, security) and what to skip (minor style, local patterns).
5. Switch off a noisy category while its prompt is fixed.
6. Define each severity level with a code example.

## Few-shot

7. Few-shot is the strongest tool for a consistent, usable output format and for ambiguous cases. It lets the model carry the judgment to patterns you did not list, and it cuts invention in extraction (informal measures, varied layouts).
8. Use 3 to 5 examples (`prompt-structure.md` rules 15 and 16), aimed at the ambiguous cases, each showing why this action and not the plausible other.
9. Show the output format: location, issue, severity, suggested fix.
10. Include an acceptable pattern beside a real issue.
11. Show varied document shapes: inline citations against a bibliography, a methods section against details in the body.
12. Fix an empty or null extraction of a required field with examples in varied formats.

## Schema output through tool use

13. `tool_use` with a JSON schema gives output that matches the schema. When the call only exists to extract JSON, `output_config.format` does the same without a forced call (`tool-use-concepts.md` in `claude-api`; `api-tool-use.md` rules 43 to 49). It removes syntax errors. It does not remove semantic ones: line items that do not sum to the total, a value in the wrong field.
14. Make a field optional or nullable when the source may not have it. A required field makes the model invent a value.
15. Add an `"unclear"` enum value for ambiguous cases. For a category that will grow, use `"other"` plus a detail string.
16. Put normalization rules in the prompt next to the strict schema.
17. With several extraction schemas and an unknown document type, `tool_choice: "any"` rules out a text reply, but it returns 400 on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5. The `auto` plus prompt line or structured output replacement is in `api-behavior.md` rules 12 to 14. The same applies to forcing one extraction first.

## Validate and retry

18. A retry sends the original document, the failed extraction and the specific validation errors.
19. A retry fixes a format mismatch or a structure error. It does not fix information that is not in the source, for example a value that lives in another document.
20. Extract `calculated_total` beside `stated_total` and flag the difference. Add a `conflict_detected` boolean for inconsistent source data.
21. Add `detected_pattern` to each finding so patterns in dismissed findings can be studied.
22. Pydantic is the usual validator in the retry loop.

## Batches API

23. Discount and window are in `models-effort-cost.md` rule 36. No latency guarantee. `custom_id` (`^[a-zA-Z0-9_-]{1,64}$`) pairs a request with its response, results come back in any order, and completion is found by polling. Up to 100,000 requests or 256 MB per batch; results are kept 29 days.
24. Each batch request is one independent Messages call: a client side tool loop cannot span requests, so an agent that needs your tools stays synchronous. Server tools (web search, web fetch, code execution, MCP connector, advisor, tool search) run their full server side loop inside a batch request, with more iterations per turn than a synchronous call before `pause_turn`.
25. Use it for work that can wait: overnight reports, weekly audits, nightly test generation. A pre merge check blocks a person and stays synchronous.
26. Work out the submit interval from the promise. For example, four hour submit windows keep a 30 hour promise when processing takes up to 24 (worked arithmetic, not a documented figure).
27. A request rejected or refused inside a batch has no fallback: resubmit only the failed documents, by `custom_id`, changed to fit: chunk the ones that were over the context limit, rephrase the refused ones.
28. Tune the prompt on a small sample before a large batch, so the first pass mostly succeeds. Warm a shared prefix with one 1h cached request first (`caching.md` rule 21).

## Independent and multi pass review

29. The model that wrote the work keeps its reasoning and rarely questions it. An independent instance with none of that context finds more than a self review instruction or extended thinking.
30. Local pass per file, then an integration pass across files.
31. Ask for a confidence per finding to route which ones a person reads, and set the thresholds on a labelled validation set (`context-reliability.md`). Uncalibrated, it is not a measure of difficulty (`SKILL.md` rule 8).

## Checklist

- [ ] Criteria say what to report and what to skip, severity has examples
- [ ] 3 to 5 few-shot examples on the ambiguous cases
- [ ] Nullable fields where the source may lack data, `unclear`, `other` plus detail
- [ ] Retry sends document, failed output and errors, and skips absent information
- [ ] Totals cross checked
- [ ] Review done by an independent instance, not the author
- [ ] Batches only for work that can wait and needs no client tools, `custom_id`, failure resubmit, SLA worked out
