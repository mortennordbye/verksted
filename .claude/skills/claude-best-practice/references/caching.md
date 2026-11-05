# Prompt caching

As of 2026-11-05. Minimums, multipliers and availability change by model, so check `prompt-caching.md` in the `claude-api` skill and the current docs before relying on a figure. Caching is usually the largest cost lever and stays on permanently.

## The invariant

1. Caching is a prefix match. Any change anywhere in the prefix invalidates everything after it. Render order is `tools`, then `system`, then `messages`.
2. Put stable content first and volatile content last. Classify each input: never changes goes early, per session next, per turn at the end, per request (timestamps, uuids, queue position) is removed or moved to the very end after the last breakpoint.
3. Check that the rendered order matches the stability order. Nothing that changes per request goes ahead of the stable prefix.

## Placing breakpoints

4. At most 4 breakpoints. They go on system text blocks, tool definitions and message content blocks (`tool_use`, `tool_result` and `document` blocks included). A `defer_loading: true` tool cannot carry one.
5. Mark the last block that stays the same across requests. Not a block holding a timestamp, and not the user message. Otherwise every request writes and none reads.
6. Large shared system prompt: mark its last block. Multi turn: mark the last block of the newest turn. Shared prefix with a varying suffix: mark the end of the shared part, never the end of the whole prompt.
7. Prompts that differ from the first 1K tokens or so do not cache. A marker there only pays the write premium.
8. Automatic caching (a top level `cache_control`) uses the last cacheable block, defaults to 5 minutes, accepts `ttl: "1h"` and takes one of the 4 slots. It is the default for multi turn.
9. Use explicit markers when the prompt ends in unique per request content, when sections change at different rates, when one block needs 1h and another 5m (the longer first), when a turn appends more than 20 positions, or when the platform lacks automatic caching.
10. The robust agent loop is one explicit breakpoint on the last block of the static system prefix plus top level automatic for the tail. With 1h, set `ttl: "1h"` on both.
11. Each breakpoint looks back at most 20 positions, counting itself as the first. On the Claude API a run of consecutive `tool_use` blocks, and a run of `tool_result` blocks, each count as one position. In a growing conversation add an intermediate breakpoint about every 15 positions.
12. The minimum cacheable prefix depends on the model, from 512 (every 5.x model) up to 4096 tokens, and it is not monotonic across generations. A shorter prefix is processed without caching and with no error, only `cache_creation_input_tokens: 0`.
13. On a message thread the top level `cache_control` is a fixed field sent on every request, and the create request's `system` and `tools` breakpoints count toward the 4 on every continue. A thread is not a cost lever: the model still reads the whole conversation, so caching matters as much as without one (`api-tool-use.md`, Message threads).

## Economics and TTL

14. Reads cost about 0.1 times base input (0.05 on Opus 5.5 and Sonnet 5.5, 0.025 on Fable 5.1). A 5 minute write costs 1.25 times and a 1 hour write 2 times. Break even is 2 requests at 5 minutes and 3 or more at 1 hour. Haiku 5.5 has a second rate card above 100K prompt tokens, and cache reads and writes count toward that length, so a long cached loop on Haiku is priced at 5 times on every request past the line.
15. TTL is 5 minutes by default. A read refreshes it for free. The clock runs from the start of the request, so generation time counts.
16. Choose from the start to start gap between requests that share the prefix, using the gap distribution and not the average: under 5 minutes use 5m, 5 to 60 minutes use 1h, over an hour neither helps, so re warm on a schedule or accept the cold miss. The measured threshold for 1h is about 1 turn in 20 following a pause of 5 to 60 minutes. Pick the TTL at the start: the first 1h request on a 5m conversation reads nothing and writes the whole prompt at the 1h price, and a 1h request does not extend 5m entries.
17. A keep alive is often cheaper than 1h: stay on 5m and re send the previous request with `max_tokens: 0` just before expiry, non streaming. Measured cheaper on Fable 5.1 and also on Sonnet 5.5 and Opus 5.5 for short pauses; 1h wins when pauses approach an hour.
18. Caches are isolated per workspace on the Claude API, Platform on AWS and Foundry, and per organization on Bedrock and Google Cloud. Split workspaces mean separate entries.
19. Cache reads do not count toward input token rate limits on the Claude API, so a warm cache raises throughput as well as cutting cost.
20. Without usage data, estimate the hit rate by walking timestamps and counting a hit when the gap is within the TTL, or with a Poisson estimate. Both beat comparing the average gap to the TTL.
21. Batches: a batch with a shared prefix gets a 30 to 98 percent hit rate, best effort. Send one request carrying the prefix with a 1h block first, let it finish, then submit the rest with identical `cache_control` blocks. The 1h duration fits because batch requests usually complete in 5 minutes to an hour, and the batch discount stacks on the cache discount.

## What silently breaks it

22. `datetime.now()`, `Date.now()` or `time.time()` in the system prompt.
23. A uuid or request id early in the prompt.
24. `json.dumps` without `sort_keys=True`, iterating a set, or non deterministic key order in a `tool_use` input.
25. A session or user id in the system prompt.
26. A conditional system section (`if flag: system += ...`).
27. A tool list that varies per user. Sort tools by name.
28. Editing or reordering tool definitions, switching model, toggling web search or citations, switching `speed`, changing `thinking` or top level `effort`, adding or removing images, changing the structured output format, changing a task budget, changing the TTL, and each context editing pass.
29. Fix by moving the piece after the last breakpoint, making it deterministic, or deleting it.
30. Note on the source: the invalidation table in the `claude-api` `prompt-caching.md` has no legend; its Yes and No mean "cache remains valid", not "invalidates". The live table marks the tool definitions row as invalidating everything and has no model row at all; model scoping comes from the prose. Pin `model`, `thinking` and `effort` per route.

## What does not break it

31. Setting effort to the model's default.
32. Per message effort (beta), anywhere in `messages`.
33. Thinking blocks passed back unchanged to a model that can read them.
34. Moving `cache_control` markers between requests (strip them before diffing payloads).
35. Streaming. It is not part of the prefix.
36. The 5 minute auto writes server tools make.

## Architecture rules

37. Freeze the system prompt. Inject dynamic context later in `messages`. To change instructions mid conversation, append a `{"role": "system"}` message (no beta header; Opus 5, 5.5 and 4.8, Fable 5 and 5.1, Mythos 5 and 5.1, Sonnet 5.5, Haiku 5.5) and not an edit of `system`. Sonnet 5 does not support it: catch the 400 and fall back to a `<system-reminder>` block in a user turn.
38. A mid conversation system message must follow a user message (or an assistant message ending in server tool use), be the last entry or be followed by an assistant turn, and cannot be `messages[0]`. It is text only. It is the non spoofable operator channel.
39. For a per turn reminder use `clear_at: "next_user_message"` (beta `mid-conversation-system-clear-at-2026-08-21`). Never delete earlier reminders: a delete is a history edit that misses the cache and, on several models, invalidates later thinking blocks.
40. Do not change tools or model mid conversation. For tool changes use `tool_addition` and `tool_removal` blocks (beta `mid-conversation-tool-changes-2026-07-01`), a definition inside a mid conversation message (beta `inline-tools-2026-09-15`), or tool search.
41. A fork (summarization, compaction, a subagent) copies the parent's `system`, `tools` and `model` verbatim and appends its own content at the end.
42. On models that run the preserved thinking check, an edit to `system`, `tools` or earlier messages breaks the earlier reasoning as well as the cache. Keep `system` and `tools` fixed and `messages` append only. See `api-behavior.md`.
43. Concurrent requests do not share an entry until the first response starts streaming. For fan out, send one, wait for its first streamed token, then send the rest. N workers with different prompts write N entries.
44. Pre warm with a `max_tokens: 0` request: no output billed, `content: []`, the write charge applies. Worth it only when first request latency is visible, the prefix is large and there is a moment before traffic. Match the real `thinking` and `effort`, and put the marker on the last block shared with the real request. It is rejected with streaming, `thinking.type: "enabled"`, `output_config.format`, forced `tool_choice` and Batches. Skip it for continuous traffic, small prefixes, per user prefixes and many speculative prefixes.
45. On demand compaction: `cache_control` on the returned `compaction` block places a breakpoint after the summary. The messages it replaced are gone from the prefix, so the first request after a compaction writes.

## Verifying

46. Total prompt tokens are `cache_read_input_tokens` plus `cache_creation_input_tokens` plus `input_tokens` (the uncached remainder). `usage.cache_creation` splits writes by 5m and 1h.
47. A healthy loop reads the whole prior prefix and the read grows. Creation is about one turn's delta. `input_tokens` is only the tail.
48. Creation near the full conversation size on every request means the prefix is rewritten upstream, thinking blocks are stripped server side, or a turn spans more than 20 positions. Zero reads across identical prefixes means a silent invalidator: log consecutive full payloads and diff adjacent pairs.
49. Cache diagnostics: send `diagnostics: {previous_message_id: ...}` (`null` on the first request) and read `response.diagnostics`. The `cache-diagnosis-2026-04-07` header is no longer required; the `diagnostics` object is the opt in.
50. Verify after every change. The costliest failure is silent. Keep an integration test that asserts `cache_read_input_tokens > 0` on a second identical request. A cache probe sends one request twice and exits non zero if the second shows no reads. It costs real tokens.
51. Measure a caching change on a warm cache: run sequentially and read from the second request on. An effort or model comparison is cache cold at its first request, so compare from the second.

## Checklist

- [ ] Stable content first, nothing per request ahead of the last breakpoint
- [ ] Breakpoint on the last stable block, not the end of the prompt
- [ ] Prefix above the model's minimum
- [ ] TTL chosen from the gap distribution, at the start, and a keep alive priced against 1h
- [ ] Tools sorted, JSON serialized deterministically
- [ ] Model, tools, thinking, effort and TTL fixed within a conversation
- [ ] Instruction changes are appended system messages
- [ ] A test asserts cache reads on the second request
