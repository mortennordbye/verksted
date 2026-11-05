# Request configuration and API behaviour

As of 2026-10-16. Per model rules change every release, so read the model's row in the `claude-api` skill (Thinking and Effort) and its migration notes before changing a request shape. This file holds the standing rules.

## Thinking

1. Use adaptive thinking, `thinking: {type: "adaptive"}`. The model decides when and how much to think and interleaves thinking between tool calls. There is no token budget to tune. `effort` is the control (see `models-effort-cost.md`).
2. `budget_tokens` is removed on Fable 5 and 5.1, Opus 5.5, 5, 4.8 and 4.7, Sonnet 5.5 and 5, and Haiku 5.5, and returns a 400. It is deprecated on Opus 4.6 and Sonnet 4.6. Only Haiku 4.5 and older models still take it. Do not switch to an older model because someone asks for an "extended thinking budget".
3. Disabling thinking differs per model:
   - Fable 5 and 5.1: always on. Omit `thinking`. `disabled` returns 400.
   - Opus 5.5: always on. `disabled` and `enabled` with a budget return 400 at every effort. Lower effort instead.
   - Opus 5: `disabled` only at `high` or below, 400 at `xhigh` and `max`.
   - Sonnet 5.5: `disabled` returns 400. To turn thinking off send `{type: "between_tools"}` at `high` or below. It takes no other field, rejects per message effort changes, and works only on Sonnet 5.5, so a body re sent to another model must drop it.
   - Haiku 5.5: `disabled` accepted at `high` or below, 400 above.
   - Opus 4.8 and 4.7, Sonnet 5: `disabled` accepted, and omitting `thinking` means no thinking, so set adaptive explicitly.
4. Two failure modes with thinking disabled on Opus 5: a tool call written as visible text that never runs, and `<thinking>` tags leaking into output. Turn thinking on at a lower effort. If a route must stay off, delete any "don't think" rule, do not name the tags, and add: "When you use a tool, you may say a brief sentence first. If no tool can express what the user asked for, say so instead of guessing. Do not include internal or system XML tags in your response."
5. The raw chain of thought is never returned. `display` defaults to `"omitted"` on the current models, which streams empty `thinking` blocks and shows users a long pause. Set `display: "summarized"` to show a summary, or `"updates"` (beta `thinking-display-updates-2026-08-18`) for short progress notes while reasoning stays hidden. Thinking is billed in full under every setting. Build for zero or more non empty thinking blocks.
6. Read content blocks by `type`, never by position. Pass thinking blocks back unchanged, including empty ones. Do not strip them yourself, because that can cause signature 400s.
7. Non default `temperature`, `top_p` and `top_k` return 400 on Opus 4.7 and later, Sonnet 5 and later, Fable 5 and 5.1, and Haiku 5.5. Omit all three and steer by prompt. `temperature: 0` never guaranteed identical output.
8. Stream when `max_tokens` is above about 16K, and always for 128K. Use the SDK's final message helper if you do not need events. Turns on Fable 5.1 can run many minutes, so plan timeouts, streaming and progress UX.

## Forced tool choice and prefill are gone

9. `tool_choice` of `any` or `tool` returns 400 on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5, including on `count_tokens` and Batches. `auto` and `none` are unchanged. Still accepted on Opus 5, Sonnet 5 and Haiku 5.5, where it skips thinking.
10. Replace it with `auto` plus a prompt line that names the tool and says when it applies, and `strict: true` with `additionalProperties: false` so arguments are schema valid. If the forced call only existed to get JSON back, use structured outputs. If the app needs a specific call this turn, append a `role: "system"` message after the latest user turn that names the tool, says it is required this turn and to open with it, and keep it in history.
11. `auto` does not guarantee a call. Check that a `tool_use` block exists and retry or fall back. Delete retry loops that depended on forcing.
12. A trailing assistant turn (prefill) returns 400 on Opus 4.6 and later, Sonnet 4.6 and later, Fable 5 and 5.1, and Haiku 5.5. Replacements:

| Prefill was for | Use |
|---|---|
| JSON, YAML, a schema | `output_config.format` json_schema |
| A classification label | A tool with an enum field, or structured outputs |
| Skipping a preamble | "Respond directly without preamble. Do not start with phrases like 'Here is...' or 'Based on...'" |
| Continuing a cut response | "Your previous response was interrupted and ended with `[last text]`. Continue from there." |
| Injecting a reminder | The user turn, a tool call, or compaction |

13. After the fix, no code path may emit a trailing assistant turn, and the stop sequence, regex and parse retry code around it is cruft.

## Refusals

14. A decline is HTTP 200 with `stop_reason: "refusal"` and a `stop_details` object. Code that indexes `content[0]` breaks. Branch on `stop_reason` and never on `stop_details`, which can be `null`. `stop_details` is only populated when the reason is `refusal`, so guard before reading it.
15. A classifier can fire before any output (empty content, still counts against rate limits) or mid stream (billed normally, discard the partial output).
16. Categories seen: `cyber`, `bio`, `reasoning_extraction`, `frontier_llm`, `general_harms`. `reasoning_extraction` is not retried on a fallback. A prompt that asks the model to reproduce its reasoning can trigger it, so ask for a short explanation.
17. Opt in to fallbacks from day one for Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5. Preferred: server side `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, which routes by refusal category (Claude API and Platform on AWS). The older array form uses beta `server-side-fallback-2026-06-01`. The two headers are not interchangeable. On Bedrock, Vertex and Foundry use the SDK client side refusal fallback middleware, one fallback state per conversation. Server side fallback triggers on policy declines only, never on rate limits or server errors, routes stickily for about an hour, is rejected on Batches, and the fallback model cannot read the origin model's thinking blocks.
18. Haiku 5.5 has no server side fallback. Do not send `fallbacks` there: `"default"` leaves the decline in place and a model list returns 400. Sonnet 5.5 `"default"` retries only `cyber` and `frontier_llm`.
19. Fable 5.1 and Mythos 5.1 need 30 day data retention. Otherwise every request returns 400 `invalid_request_error`.

## History is append only (preserved thinking)

20. A thinking block is bound to the model that produced it (only the same or a newer model can read it) and to the conversation prefix: `system`, `tools` and every earlier message. Editing the prefix makes later blocks fail with a 400 ("bound to a different conversation").
21. It applies to Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5, for accounts created on or after 2026-08-31 and for any request that sets `thinking.block_binding.prefix_mismatch_behavior` (`"error"` or `"drop_block"`, beta `thinking-binding-controls-2026-08-01`). Mythos 5.1 does not run it.
22. These edits invalidate it: editing, reordering or removing earlier turns including deleting old tool results, injecting per request text into an earlier turn and removing it later, rebuilding `system` or `tools`, removing a thinking block from anywhere but the start, and an image or document URL that serves different bytes.
23. These are safe: appends, removing a leading run of thinking blocks oldest first, reordering `tools`, changing `max_tokens`, `effort`, `tool_choice` or `metadata`, moving `cache_control`, and server side compaction and context editing.
24. Check it in three steps. Capture request bodies over several turns including a compaction and a tool change, and confirm consecutive requests are byte identical in `system`, `tools` and the shared `messages` prefix. Run a normal session with `drop_block` and log `input_transformations` on every response: empty means intact, `prefix_binding_mismatch` means an edit, `model_binding_mismatch` means a model switch. Then pick the production setting explicitly and watch it. Use `"error"` in CI.
25. Append only replacements: a mid session system change is a frozen `system` plus an appended system message. A tool change is the full set declared up front (`defer_loading: true` for hidden ones) plus `tool_addition` and `tool_removal` blocks. A per turn reminder is a `clear_at: "next_user_message"` system message left in history. Deleting old tool results becomes server side context editing or compaction. Compaction is server side or client side "simple compaction" (summary only). Keep tail and async compaction break the check. Cross turn files are uploaded once and sent as `file_id`. Declare any tool the session may need later, such as `send_to_user`, in the first request.
26. When blocks are dropped they are unbilled. Strip all thinking and retry is a one time recovery, then fix the harness.

## Errors

27. Retry 429, 500 and 529 with backoff. Do not retry 400, 401, 402, 403, 404 or 413.

| Code | Type |
|---|---|
| 400 | `invalid_request_error` |
| 401 | `authentication_error` |
| 402 | `billing_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 529 | `overloaded_error` |

28. A 404 can mean the model does not exist or the org cannot use it. List `GET /v1/models` to see which. A beta header that does not exist or is not enabled returns 400. A 401 can be an OAuth token sent through `x-api-key` instead of `Authorization: Bearer`, or both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` set. A 413 means truncate, resize images or chunk.
29. Catch a chain, most specific first, never one broad class and never by matching message text: not found, rate limit, status error, connection error. Subclass order differs by SDK (TypeScript's connection error subclasses the API error). Go has one error type: `errors.As` then branch on `StatusCode`.
30. Errors carry a `request_id`. Log it with the failure class and the retry count. Check `retry-after` and the rate limit headers on a 429. The SDKs retry 429 and 5xx twice by default with backoff.
31. Client timeout is 10 minutes by default and the unit differs by SDK (seconds in Python and Ruby, milliseconds in TypeScript). A timeout is retried, so wall clock can reach the timeout times the retries plus one.
32. A server tool error does not raise: web search and fetch return 200 with an error object in the result block. A success `content` is a list and an error `content` is an object, so branch before indexing.
## Platforms

33. Check `platform-availability.md` before writing code for Bedrock, Vertex, Foundry or Platform on AWS. Use that platform's own client class, not the first party client with a base url. Programmatic tool calling, Skills, Managed Agents, the advisor tool and fast mode are not on every platform.

## Checklist

- [ ] Adaptive thinking, no `budget_tokens`, no sampling parameters
- [ ] Effort set explicitly, `max_tokens` sized for thinking plus reply
- [ ] No forced `tool_choice` and no trailing assistant turn on current models
- [ ] `stop_reason` handled before `content`: `refusal`, `max_tokens` and `pause_turn` each have a branch, refusal fallback opted in
- [ ] History append only, thinking blocks passed back unchanged
- [ ] Typed error chain, retries only on 429 and 5xx, request id logged
- [ ] Streaming on for large `max_tokens`
