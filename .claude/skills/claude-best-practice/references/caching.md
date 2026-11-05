# Prompt caching

As of 2026-10-16. Minimums, multipliers and availability change by model, so check `prompt-caching.md` in the `claude-api` skill and the current docs before relying on a figure. Caching is usually the largest cost lever and stays on permanently.

## The invariant

1. Caching is a prefix match. Any change anywhere in the prefix invalidates everything after it. Render order is `tools`, then `system`, then `messages`.
2. Put stable content first and volatile content last. Classify each input: never changes goes early, per session next, per turn at the end, per request (timestamps, uuids, queue position) is removed or moved to the very end after the last breakpoint.
3. Check that the rendered order matches the stability order. Nothing that changes per request goes ahead of the stable prefix.

## Placing breakpoints

4. At most 4 breakpoints. They go on system text blocks, tool definitions and message content blocks.
5. Mark the last block that stays the same across requests. Not a block holding a timestamp, and not the user message. Otherwise every request writes and none reads.
6. Large shared system prompt: mark its last block. Multi turn: mark the last block of the newest turn. Shared prefix with a varying suffix: mark the end of the shared part, never the end of the whole prompt.
7. Prompts that differ from the first 1K tokens or so do not cache. A marker there only pays the write premium.
8. Automatic caching (a top level `cache_control`) uses the last cacheable block, defaults to 5 minutes, accepts `ttl: "1h"` and takes one of the 4 slots. It is the default for multi turn.
9. Use explicit markers when the prompt ends in unique per request content, when sections change at different rates, when one block needs 1h and another 5m (the longer first), when a turn appends more than 20 positions, or when the platform lacks automatic caching.
10. The robust agent loop is one explicit breakpoint on the last block of the static system prefix plus top level automatic for the tail. With 1h, set `ttl: "1h"` on both.
11. Each breakpoint looks back at most 20 positions. A run of consecutive `tool_use` blocks, and a run of `tool_result` blocks, each count as one position. In a growing conversation add an intermediate breakpoint about every 15 positions.
12. The minimum cacheable prefix depends on the model, from 512 up to 4096 tokens, and it is not monotonic across generations. A shorter prefix is processed without caching and with no error, only `cache_creation_input_tokens: 0`.

## Economics and TTL

13. Reads cost about 0.1 times base input (0.05 on Opus 5.5 and Sonnet 5.5, 0.025 on Fable 5.1). A 5 minute write costs 1.25 times and a 1 hour write 2 times. Break even is 2 requests at 5 minutes and 3 or more at 1 hour.
14. TTL is 5 minutes by default. A read refreshes it for free. The clock runs from the start of the request, so generation time counts.
15. Choose from the start to start gap between requests that share the prefix, using the gap distribution and not the average: under 5 minutes use 5m, 5 to 60 minutes use 1h, over an hour neither helps, so re warm on a schedule or accept the cold miss.
16. On Fable 5.1, a keep alive is usually cheaper than 1h. Stay on 5m and re send the previous request with `max_tokens: 0` just before expiry, non streaming.
17. Caches are isolated per workspace on the Claude API, Platform on AWS and Foundry, and per organization on Bedrock and Google Cloud. Split workspaces mean separate entries.
18. Without usage data, estimate the hit rate by walking timestamps and counting a hit when the gap is within the TTL, or with a Poisson estimate. Both beat comparing the average gap to the TTL.

## What silently breaks it

19. `datetime.now()`, `Date.now()` or `time.time()` in the system prompt.
20. A uuid or request id early in the prompt.
21. `json.dumps` without `sort_keys=True`, iterating a set, or non deterministic key order in a `tool_use` input.
22. A session or user id in the system prompt.
23. A conditional system section (`if flag: system += ...`).
24. A tool list that varies per user. Sort tools by name.
25. Editing tool definitions, switching model, toggling web search or citations, switching `speed`, changing `thinking` or top level `effort`, adding or removing images, changing the structured output format, changing a task budget, and each context editing pass.
26. Fix by moving the piece after the last breakpoint, making it deterministic, or deleting it.
27. Note on the source: the invalidation table in `prompt-caching.md` reads opposite to its own prose on tool and model changes (it says no invalidation, the prose says the whole cache). The prose is authoritative. Pin `thinking` and `effort` per route.

## What does not break it

28. Setting effort to the model's default.
29. Per message effort (beta), anywhere in `messages`.
30. Thinking blocks passed back unchanged to a model that can read them.
31. Moving `cache_control` markers between requests (strip them before diffing payloads).
32. Streaming. It is not part of the prefix.
33. The 5 minute auto writes server tools make.

## Architecture rules

34. Freeze the system prompt. Inject dynamic context later in `messages`. To change instructions mid conversation, append a `{"role": "system"}` message (no beta header; Opus 5, 5.5 and 4.8, Fable 5 and 5.1, Mythos 5 and 5.1, Sonnet 5.5) and not an edit of `system`. `prompt-caching.md` omits Sonnet 5, so treat it as unsupported: catch the 400 and fall back to a `<system-reminder>` block in a user turn.
35. A mid conversation system message must follow a user message (or an assistant message ending in server tool use), be the last entry or be followed by an assistant turn, and cannot be `messages[0]`. It is text only. It is the non spoofable operator channel.
36. For a per turn reminder use `clear_at: "next_user_message"` (beta `mid-conversation-system-clear-at-2026-08-21`). Never delete earlier reminders: a delete is a history edit that misses the cache and, on several models, invalidates later thinking blocks.
37. Do not change tools or model mid conversation. For tool changes use `tool_addition` and `tool_removal` blocks (beta `mid-conversation-tool-changes-2026-07-01`) or tool search.
38. A fork (summarization, compaction, a subagent) copies the parent's `system`, `tools` and `model` verbatim and appends its own content at the end.
39. On models that run the preserved thinking check, an edit to `system`, `tools` or earlier messages breaks the earlier reasoning as well as the cache. Keep `system` and `tools` fixed and `messages` append only. See `api-behavior.md`.
40. Concurrent requests do not share an entry until the first response starts streaming. For fan out, send one, wait for its first streamed token, then send the rest. N workers with different prompts write N entries.
41. Pre warm with a `max_tokens: 0` request: no output billed, `content: []`, the write charge applies. Worth it only when first request latency is visible, the prefix is large and there is a moment before traffic. Match the real `thinking` and `effort`, and put the marker on the last block shared with the real request. It is rejected with streaming, `thinking.type: "enabled"`, `output_config.format`, forced `tool_choice` and Batches. Skip it for continuous traffic, small prefixes, per user prefixes and many speculative prefixes.

## Verifying

42. Total prompt tokens are `cache_read_input_tokens` plus `cache_creation_input_tokens` plus `input_tokens` (the uncached remainder). `usage.cache_creation` splits writes by 5m and 1h.
43. A healthy loop reads the whole prior prefix and the read grows. Creation is about one turn's delta. `input_tokens` is only the tail.
44. Creation near the full conversation size on every request means the prefix is rewritten upstream, thinking blocks are stripped server side, or a turn spans more than 20 positions. Zero reads across identical prefixes means a silent invalidator: log consecutive full payloads and diff adjacent pairs.
45. Cache diagnostics (beta `cache-diagnosis-2026-04-07`): send `diagnostics: {previous_message_id: ...}` and read `response.diagnostics`.
46. Verify after every change. The costliest failure is silent. Keep an integration test that asserts `cache_read_input_tokens > 0` on a second identical request. A cache probe sends one request twice and exits non zero if the second shows no reads. It costs real tokens.
47. Measure a caching change on a warm cache: run sequentially and read from the second request on.

## Checklist

- [ ] Stable content first, nothing per request ahead of the last breakpoint
- [ ] Breakpoint on the last stable block, not the end of the prompt
- [ ] Prefix above the model's minimum
- [ ] TTL chosen from the gap distribution
- [ ] Tools sorted, JSON serialized deterministically
- [ ] Model, tools, thinking and effort fixed within a conversation
- [ ] Instruction changes are appended system messages
- [ ] A test asserts cache reads on the second request
