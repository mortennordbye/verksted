# Request configuration and API behaviour

As of 2026-11-05. Per model rules change every release, so read the model's row in the `claude-api` skill (Thinking and Effort) and its migration notes before changing a request shape. This file holds the standing rules.

## API version

1. The `anthropic-version` header is how the API ships breaking changes. The current version is `2026-10-21`, sent by default from Python `anthropic` 2.0, TypeScript `@anthropic-ai/sdk` 1.0, Go v2, Java 3.0, C# 13.0, PHP 1.0, Ruby 2.0 and `ant` 2.0. Know which version the code sends: upgrading an SDK across one of these majors is an API version migration, not only a package bump.
2. On `2026-10-21`: any `temperature`, `top_p` or `top_k`, even at its default value, returns 400 on every model; a `document` block directly in an `assistant` message returns 400; a `text` block with non empty `citations` in a `user` message returns 400 (strip citations when copying a reply into a user turn, keep the text). Batches created on the old version finish on it. Older models on Bedrock (below 4.7) stay on the old version.
3. On `2023-06-01`, non default sampling values already return 400 on Opus 4.7 and later, Sonnet 5 and later, Fable 5 and 5.1, and Haiku 5.5. Either way: omit all three and steer by prompt. `temperature: 0` never guaranteed identical output.

## Thinking

4. Use adaptive thinking, `thinking: {type: "adaptive"}`. The model decides when and how much to think and interleaves thinking between tool calls. There is no token budget to tune. `effort` is the control (see `models-effort-cost.md`).
5. `budget_tokens` is removed on Fable 5 and 5.1, Opus 5.5, 5, 4.8 and 4.7, Sonnet 5.5 and 5, and Haiku 5.5, and returns a 400. It is deprecated on Opus 4.6 and Sonnet 4.6. Only Haiku 4.5 and older models still take it. Do not switch to an older model because someone asks for an "extended thinking budget".
6. Disabling thinking differs per model. The Models API reports it (`capabilities.thinking.types.disabled`, `.between_tools`):
   - Fable 5 and 5.1: always on. Omit `thinking`. `disabled` returns 400.
   - Opus 5.5: always on. `disabled` and `enabled` with a budget return 400 at every effort. Lower effort instead.
   - Opus 5: `disabled` only at `high` or below, 400 at `xhigh` and `max`. Omitting `thinking` runs adaptive.
   - Sonnet 5.5: `disabled` returns 400. To turn thinking off send `{type: "between_tools"}` at `high` or below. It takes no other field, rejects per message effort changes, and works only on Sonnet 5.5, so a body re sent to another model must drop it.
   - Sonnet 5 and Haiku 5.5: omitting `thinking` runs adaptive. `disabled` is accepted (Haiku 5.5 only at `high` or below).
   - Opus 4.8 and 4.7: `disabled` accepted, and omitting `thinking` means no thinking, so set adaptive explicitly.
7. Two failure modes with thinking disabled on Opus 5: a tool call written as visible text that never runs, and `<thinking>` tags leaking into output. Turn thinking on at a lower effort. If a route must stay off, delete any "don't think" rule, do not name the tags, and add: "When you use a tool, you may say a brief sentence first. If no tool can express what the user asked for, say so instead of guessing. Do not include internal or system XML tags in your response."
8. The raw chain of thought is never returned. `display` defaults to `"omitted"` on the current models, which streams empty `thinking` blocks and shows users a long pause. Set `display: "summarized"` to show a summary, or `"updates"` (beta `thinking-display-updates-2026-08-18`) for short progress notes while reasoning stays hidden. Thinking is billed in full under every setting. Build for zero or more non empty thinking blocks.
9. On Opus 5.5, Sonnet 5.5 and Fable 5.1 the text the model used to write between tool calls arrives as progress update `thinking` blocks, empty under the default display. A client that renders only `text` blocks goes silent for the whole tool loop. Render the summaries (`display: "updates"` or `"summarized"`), or accept the silence on purpose. Sonnet 5.5 with `between_tools` returns the notes as text instead, and rejects `display`.
10. Read content blocks by `type`, never by position. Pass thinking blocks back unchanged, including empty ones. Do not strip them yourself, because that can cause signature 400s.
11. Stream when `max_tokens` is above about 16K, and always for 128K. Use the SDK's final message helper if you do not need events. Turns on Fable 5.1 can run many minutes, so plan timeouts, streaming and progress UX. The request size cap on the Claude API is 128 MB (32 MB before 2026-10-28).

## Forced tool choice and prefill are gone

12. `tool_choice` of `any` or `tool` returns 400 on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5, including on `count_tokens` and Batches. `auto` and `none` are unchanged. Still accepted on Opus 5, Sonnet 5 and Haiku 5.5, where forcing skips thinking (on Bedrock, Sonnet 5 also needs `thinking: {type: "disabled"}` to force).
13. Replace it with `auto` plus a prompt line that names the tool and says when it applies, and `strict: true` with `additionalProperties: false` so arguments are schema valid. If the forced call only existed to get JSON back, use structured outputs. If the app needs a specific call this turn, append a `role: "system"` message after the latest user turn that names the tool, says it is required this turn and to open with it, and keep it in history.
14. `auto` does not guarantee a call. Check that a `tool_use` block exists and retry or fall back. Delete retry loops that depended on forcing.
15. A trailing assistant turn (prefill) returns 400 on Opus 4.6 and later, Sonnet 4.6 and later, Fable 5 and 5.1, and Haiku 5.5. Replacements:

| Prefill was for | Use |
|---|---|
| JSON, YAML, a schema | `output_config.format` json_schema |
| A classification label | A tool with an enum field, or structured outputs |
| Skipping a preamble | "Respond directly without preamble. Do not start with phrases like 'Here is...' or 'Based on...'" |
| Continuing a cut response | "Your previous response was interrupted and ended with `[last text]`. Continue from there." |
| Injecting a reminder | The user turn, a tool call, or compaction |

16. After the fix, no code path may emit a trailing assistant turn, and the stop sequence, regex and parse retry code around it is cruft.

## Refusals

17. A decline is HTTP 200 with `stop_reason: "refusal"`. Code that indexes `content[0]` breaks. Branch on `stop_reason`, never on `stop_details`: it is populated only on a refusal and can be `null` even then, so guard before reading it.
18. A classifier can fire before any output (empty content, still counts against rate limits) or mid stream (billed normally, discard the partial output).
19. Categories seen: `cyber`, `bio`, `reasoning_extraction`, `frontier_llm`, `general_harms`. `reasoning_extraction` is not retried on a fallback. A prompt that asks the model to reproduce its reasoning can trigger it, so ask for a short explanation.
20. Opt in to fallbacks from day one for Fable 5.1, Opus 5.5, Opus 5 and Sonnet 5.5. Preferred: server side `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, which routes by refusal category (Claude API, Platform on AWS, and Google Cloud Anthropic managed). The older array form uses beta `server-side-fallback-2026-06-01`. The two headers are not interchangeable. On Bedrock, Vertex and Foundry use the SDK client side refusal fallback middleware, one fallback state per conversation. Server side fallback triggers on policy declines only, never on rate limits or server errors, routes stickily for about an hour, is rejected on Batches, and the fallback model cannot read the origin model's thinking blocks. A mid stream decline leaves a fallback credit (beta `fallback-credit-2026-07-01`, 5 minute expiry, exact body replay) that the SDK middleware redeems for you.
21. Haiku 5.5 has no server side fallback. Do not send `fallbacks` there: `"default"` leaves the decline in place and a model list returns 400. Sonnet 5.5 `"default"` retries only `cyber` and `frontier_llm`.
22. Fable 5.1 and Mythos 5.1 need 30 day data retention. Otherwise every request returns 400 `invalid_request_error`.
23. On a message thread, a refusal ends the thread. Start a new one that leaves out or rephrases the turn that led to it (`api-tool-use.md`, Message threads).

## History is append only (preserved thinking)

24. A thinking block is bound to the conversation prefix (`system`, `tools` and every earlier message) and to a fixed set of models that may read it. The set is per model, not "same or newer": Opus 5.5 reads Sonnet 5.5 and Haiku 5.5 blocks but no Fable block; Haiku 5.5 reads none from Opus 5, Opus 5.5 or Sonnet 5.5; Fable 5.1 blocks are read only by Fable 5.1 and Mythos 5.1. A block the current model cannot read is dropped unbilled and `prefix_mismatch_behavior` has no say in that. Editing the prefix makes later blocks fail with a 400 ("bound to a different conversation").
25. Who is enforced: Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 for accounts created on or after 2026-08-31 and for any request that sets `thinking.block_binding.prefix_mismatch_behavior` (`"error"` or `"drop_block"`, beta `thinking-binding-controls-2026-08-01`). Mythos 5.1 is enforced for every account. Older accounts without the setting pass failing blocks to the model, billed, and the beta reports them as `thinking_mismatch_allowed`. `block_binding` needs adaptive thinking on Sonnet 5.5 and Haiku 5.5.
26. Account binding: Sonnet 5.5 and Haiku 5.5 blocks work only in the account that produced them or one linked to it. Another account's blocks are dropped (`organization_binding_mismatch`). A service that stores conversations for several customers replays each through the account that produced it.
27. These edits invalidate it: editing, reordering or removing earlier turns including deleting old tool results, injecting per request text into an earlier turn and removing it later, rebuilding `system`, adding, removing, renaming or editing a tool in `tools`, removing a thinking block from the middle and keeping later ones, putting a removed block back, deleting or rewording a turn scoped system message, and an image or document URL that serves different bytes.
28. These are safe: appends, removing thinking blocks from the start, from the end or all of them (the model loses that reasoning), adding a `defer_loading: true` tool nothing has referenced yet, changing `model` (unreadable blocks drop), changing `max_tokens`, `effort`, `output_config`, `tool_choice`, `metadata` or `thinking.display`, adding, moving or removing `cache_control`, a rotating signed URL that serves the same bytes, server side compaction and context editing, and leaving a cleared turn scoped system message in place. Reordering `tools` is not listed as safe; sort them once and never reorder (it also breaks the cache, `caching.md`).
29. Check it in three steps. Capture request bodies over several turns including a compaction and a tool change, and confirm consecutive requests are byte identical in `system`, `tools` and the shared `messages` prefix. Run a normal session with `drop_block` and log `input_transformations` on every response (in `message_start` when streaming): empty means intact, `prefix_binding_mismatch` means an edit, `model_binding_mismatch` means a model switch, `organization_binding_mismatch` means another account's block. Then pick the production setting explicitly and watch it. Use `"error"` in CI. On a 400 in production, do not resend the same body: retry once with `drop_block` and store that choice for the session.
30. Append only replacements: a mid session system change is a frozen `system` plus an appended system message. A tool change is the full set declared up front (`defer_loading: true` for hidden ones) plus `tool_addition` and `tool_removal` blocks (beta `mid-conversation-tool-changes-2026-07-01`), or a definition inside a mid conversation message (beta `inline-tools-2026-09-15`). A per turn reminder is a `clear_at: "next_user_message"` system message left in history. An effort change is a per message effort system message. Deleting old tool results becomes server side context editing. Dropping old turns becomes on demand compaction (beta `compact-2026-09-04`), which keeps the retained turns' thinking valid including with recent turns kept word for word and when run in the background, or a client side summary that replaces the whole history and replays no earlier thinking. Client side keep tail compaction (a summary plus replayed recent turns with their thinking) breaks the check, and so does threshold compaction when you reinsert turns after the block; strip those blocks or set `drop_block`. Cross turn files are uploaded once and sent as `file_id`. Declare any tool the session may need later, such as `send_to_user`, in the first request.
31. When blocks are dropped they are unbilled. Strip all thinking and retry is a one time recovery, then fix the harness. `drop_block` as a standing setting is a stopgap that raises output tokens; measure it.

## Errors

32. Retry 429, 500, 529 and 504 with backoff. Do not retry 400, 401, 402, 403, 404, 409 or 413.

| Code | Type |
|---|---|
| 400 | `invalid_request_error` (also an org or workspace spend limit) |
| 401 | `authentication_error` |
| 402 | `billing_error` |
| 403 | `permission_error` |
| 404 | `not_found_error` |
| 409 | `conflict_error` |
| 413 | `request_too_large` |
| 429 | `rate_limit_error` |
| 500 | `api_error` |
| 504 | `timeout_error` |
| 529 | `overloaded_error` |

33. A 404 can mean the model does not exist or the org cannot use it. List `GET /v1/models` to see which. A beta header that does not exist or is not enabled returns 400. A 401 can be an OAuth token sent through `x-api-key` instead of `Authorization: Bearer`, or both `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` set. A 413 means truncate, resize images or chunk. A tier spend cap 429 has no `retry-after` and keeps failing until access resumes, so a blind retry loop burns nothing but time.
34. Catch a chain, most specific first, never one broad class and never by matching message text: not found, rate limit, status error, connection error. Subclass order differs by SDK (TypeScript's connection error subclasses the API error). Go has one error type: `errors.As` then branch on `StatusCode`.
35. Errors carry a `request_id`. Log it with the failure class and the retry count. Check `retry-after` and the rate limit headers on a 429. The SDKs retry 429 and 5xx twice by default with backoff.
36. Client timeout is 10 minutes by default and the unit differs by SDK (seconds in Python and Ruby, milliseconds in TypeScript). A timeout is retried, so wall clock can reach the timeout times the retries plus one.
37. A server tool error does not raise: web search and fetch return 200 with an error object in the result block. For web search a success `content` is a list and an error `content` is an object, so branch before indexing. For web fetch both are objects, so branch on the content's `type`.

## Platforms

38. Check `platform-availability.md` before writing code for Bedrock, Vertex, Foundry, Platform on AWS or Google Cloud (Anthropic managed). Use that platform's own client class, not the first party client with a base url. Programmatic tool calling, Skills, Managed Agents, the advisor tool, fast mode, message threads and on demand compaction are not on every platform.

## Checklist

- [ ] API version known: the SDK major pins it, and no request sends `temperature`, `top_p` or `top_k`
- [ ] Adaptive thinking, no `budget_tokens`
- [ ] Effort set explicitly, `max_tokens` sized for thinking plus reply
- [ ] Progress between tool calls rendered or knowingly dropped
- [ ] No forced `tool_choice` and no trailing assistant turn on current models
- [ ] `stop_reason` handled before `content`: `refusal`, `max_tokens` and `pause_turn` each have a branch, refusal fallback opted in
- [ ] History append only, thinking blocks passed back unchanged, replayed through the account that produced them
- [ ] Typed error chain, retries only on 429, 5xx and 504, request id logged
- [ ] Streaming on for large `max_tokens`
