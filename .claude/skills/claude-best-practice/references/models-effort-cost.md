# Models, effort and cost

Model ids, defaults and prices move between releases. Figures here are as of 2026-11-05. Look up capabilities with the Models API (`client.models.retrieve(id)`, read `capabilities[...]["supported"]`), and take ids, prices and per model parameters from the `claude-api` skill and the live pricing page. Never build a model id by hand.

## Unit and order

1. Optimize cost per completed task, not per token or per request. A cheaper model that fails still bills its tokens, the retry and the downstream failure. A dearer model that finishes in fewer turns can cost less.
2. The order is load bearing. Free wins first, because they cut cost without cutting quality: prompt caching, input hygiene, agent loop hygiene, output hygiene, batch. Tradeoffs last, because they trade intelligence for cost: effort and budgets, then model choice, then multi model designs.
3. Each lever is its own change, so a revert is clean and the effect is attributable. Apply in this order, not in order of size of saving.
4. Tradeoffs are shown with their measured quality cost and applied only when the owner accepts. Never trade accuracy for cost silently.
5. Have a quality bar before any of it: an eval, tests or outcome checks. Without one a saving cannot be told from a regression. Say so when none exists.
6. "Nothing here is worth changing" is a valid result.

## Effort

7. `output_config.effort` takes `low`, `medium`, `high`, `xhigh`, `max`. It sits inside `output_config`. It shapes every token: text, tool calls and thinking. It is a behavioural signal, not a budget. Lower effort gives fewer, terser tool calls and less preamble. Higher gives more calls and more explanation.
8. The default differs by model. Most default to `high`. Opus 5.5 and Haiku 5.5 default to `medium`. Passing the default equals omitting it, so set effort explicitly on every route and a model change cannot shift it unseen. Levels are recalibrated per model (Sonnet 5.5), so a level does not carry across models.
9. For how deeply it thinks, lower effort first and prompt steering second. On Opus 5.5 and Haiku 5.5 the docs say lower effort before adding a "think less" line. For shallow reasoning on a hard problem, raise effort instead of prompting around it.
10. Starting points the docs give:
    - Opus 5.5: its default `medium`, then sweep.
    - Sonnet 5.5: `high`; `medium` for agentic coding on well specified tasks; `medium` or `low` for chat and latency sensitive work.
    - Haiku 5.5: `medium`. At `low` it is more likely to skip a search, stop early or skip a check in a long agent prompt.
    - Fable 5.1: `high`.
    - Opus 4.7 and 4.8: `xhigh` for coding and agents. `max` can overthink structured output tasks.
    - Opus 5: effort does not reliably shorten visible output. Prompt for length.
11. `max_tokens` caps thinking plus reply. Raise it at high effort: 64K is the docs' starting point on Opus 5, 4.8 and 4.7 at `xhigh` and `max`; for agentic coding on Sonnet 5.5 the docs say 128K, the model's maximum, streamed. Treat `stop_reason: max_tokens` as a failed attempt, never as a retry at the same cap. It is a backstop, not a tuning knob, and a tight cap cut off many attempts without cutting cost per solved task.
12. Changing top level effort mid conversation invalidates the messages cache. Per message effort (a `role: "system"` message with `content: []` and `output_config`, beta `mid-conversation-output-config-2026-07-01`; Fable 5.1, Mythos 5.1, Opus 5.5, Opus 5, Sonnet 5.5, Haiku 5.5) does not. It needs adaptive thinking. Lowering is reliable; raising wants a big jump. A compaction block swallows it, so restate it after one.

## What effort did on measured work (directional)

13. Research and knowledge work (`cost-optimization.md` in `claude-api`): nearly flat. `low` gave up a few points for a third to a half off cost per task. `medium` matched `high`.
14. Long horizon coding: a real tradeoff. Each step down cost single digit points of pass rate for lower cost. The top settings bought little for a large multiple of cost.
15. Hard does not mean high effort. One deep research benchmark scored level across `low`, `medium` and `high` while cost climbed.
16. Run everything at a low level, then re-run only the failures higher. It needs a failure signal (tests, a checker, a validator). In coding runs it held or beat all-`high` pass rate for a little over half the cost. Price the checker and the doubled wall clock on failures. Use it for the saving, not for a lift.

## Running an effort sweep

17. Same model throughout. Cells byte identical except `output_config.effort`. One session per level, because a mid session change invalidates the cache and distorts the comparison.
18. Finish every sample request at one level before starting the next, in a stable order, so cache reads are comparable. Effort is part of the cache key, so each level's first request is cache cold; read cost from the second request on.
19. Confirm the dial is alive before trusting a curve: a step right that does not change realized `thinking_tokens` means effort is not doing anything for that workload.
20. Include a hard case you know about. Curves are flattest on easy tasks and the hard tail is where high effort pays.
21. Size and noise floor follow `evals.md` rules 5 and 7. For an effort sweep: about 50 cases and at least 5 trials per configuration for a production cutover. A smaller project eval is fine for one lever if trials repeat. The minimum is 20 to 30 frozen real requests, above the 15 case floor in `evals.md` rule 5. A difference of a task or two, or of cents, is noise. Never keep or revert on a one case swing, and never on a per case read: failures move between runs, so an effort cut needs aggregate non inferiority over several runs.
22. Read the curve as flat, steep or mixed and name the tasks that flipped.
23. Replay with side effects only in a scratch environment or against stubbed tools. A sweep is never worth a production mutation.
24. Re-sweep after a model migration, a major prompt change or a workload shift, starting from the new model's own default.
25. Every run that calls the model costs money. Get one approval for the whole measurement budget, with the expected runs and cost, and no per run approval after that.

## Choosing the model

26. The ladder, low to high: Haiku 5.5, Sonnet 5.5, Opus 5.5, Fable 5.1. Start with Opus 5.5 at its default effort. Use Fable 5.1 for demanding reasoning and long horizon agentic work, or when Opus 5.5 at higher effort still falls short. Haiku 5.5 fits high volume, latency sensitive work whose outputs can be checked, at about a twentieth of Opus's cost per correct answer in the published run; above 100K prompt tokens it is priced 5 times, cache reads included, so it is not the cheap choice for a long loop. Mythos 5.1 is the same model as Fable 5.1, offered only to approved Project Glasswing customers (`models.md` in `claude-api`), and Mythos 5 is its predecessor. Rules here that name Mythos apply to them. Use Fable 5.1 unless the org is in that program.
27. Check for an upgrade before a step down. A model a generation behind in its tier is often beaten on cost by the newer one at lower effort. It is not guaranteed, so measure. It is still a migration: re-audit the prompt and re-sweep effort.
28. Price every candidate in cost per completed task on your own traffic, including the strongest model at reduced effort. Per token price lists do not predict the ranking. Price the tail too: on one 20 problem research run two problems carried 43 percent of spend (`cost-optimization.md`).
29. The shape to expect: in the published runs the cheapest upgrade was often the newer model at a lower effort setting (`cost-optimization.md` in `claude-api`). Per task figures are not carried here because they could not be traced to a source. Measure your own.
30. Stepping down, one notch at a time:
    1. Sweep effort on the current model.
    2. If `low` passes the eval, drop one tier.
    3. Confirm what the target accepts: effort levels and the `thinking` setting you send, which it may reject.
    4. Reset effort to that tier's own default.
    5. Re-sweep down from there. On a tier with no `effort`, evaluate at its single default.
    6. Stop when there is no cheaper tier. Do not invent a step.
    7. Switch between conversations, never inside one.
31. Tune one model before adding a second. Most workloads end at the effort sweep. If the sweep shows a gap, price the stronger model alone at low effort.
32. A cascade or a mid conversation switch costs more than it looks. Caches are scoped to a model, so a switch starts cold. A fallback model may not read the earlier model's thinking blocks. A subagent starts a fresh prefix with no shared cache. Keep the main loop on one model and put the cheaper model in a subagent.
33. Advisor (a cheaper executor consults a stronger model) pays when the capability gap is wide and the executor actually consults. The consult rate is fragile: lowering effort can drop it to almost none, and then it scores below the executor alone. Sweep effort and price the stronger model alone first. Pairing rules are in `api-tool-use.md`.
34. Orchestrator (a strong model plans, cheap workers do the bulk) pays only with bulk to hand off: many independent pieces, ideally more than one context window, or a long cost tail. For one dependent chain, the coordinator's model alone at lower effort won in every measured case.
35. Cheap tokens pay by substitution, not by addition. A strong lead spends about an order of magnitude in its own tokens to consume cheap help (`evals/cost-hillclimb.md` in `claude-api`).

## Other levers

36. Batch is 50 percent off every token, cache reads and writes included, and the discounts stack. Results arrive within 24 hours, which is an expiry and not an SLA, and stay available 29 days. Keep user facing work synchronous. Not available for Managed Agents sessions, and a batch request rejects `stream`, `speed`, `fallbacks` and `max_tokens: 0`. Server tools run their full agentic loop inside a batch request. A refused request in a batch has no fallback and is resubmitted. The `output-300k-2026-03-24` beta raises `max_tokens` to 300K on batches only. Warm a shared prefix with one 1h request first (`caching.md` rule 21).
37. Fast mode (`speed: "fast"`) is a latency lever, not a cost lever: the same model at up to 2.5 times the output speed for twice the token price (Opus 5.5 at $8 and $40 per MTok), cache multipliers stacking on top. Out of preview on Opus 5.5 with no beta header; still preview on Opus 5 with the header; Opus 4.8 fast mode is removed on 2026-11-30. Claude API, Foundry and Google Cloud (Anthropic managed), not Batches or Priority Tier. Switching `speed` mid conversation misses the cache; on its own 429, fall back to standard speed knowingly.
38. Message threads cut time to first token on long loops, not cost. The model still reads the whole conversation and the price is unchanged. Keep caching on (`api-tool-use.md`, Message threads).
39. Output: state the exact shape of the answer, ideally with an example. Ask for the answer you will read, not the one that looks thorough, because the output format changes cost. Shorten reasoning with effort, not `max_tokens`. A brevity cap saves money through shorter replies, which is a reply quality tradeoff, not a free win. A stop sequence sentinel gives an early exit. Meter thinking in `usage.output_tokens_details.thinking_tokens`.
40. Input: put a big reference document behind a tool or skill, unless most calls use most of it. Drop tool recaps from the system prompt. Tool search with `defer_loading` pays past about 10K tokens of schemas. Downscale images first, at about one token per 28 by 28 patch. Use the Files API for large tables. Give accessors `limit`, `fields` and `date_range`. Count tokens before ingesting and truncate, summarize or route. A smaller prefix is not automatically cheaper, because the model may spend discovery turns. Validate against the eval.
41. Loop hygiene matters only for deep loops with bulky results. Context editing is a window tool and not a saving, since every clearing pass rewrites the cached conversation (plus 73 percent on a short run). Compaction took about a third off a long run and saved nothing on a short one. Subagents take self contained bulky steps.
42. Time awareness: telling an agent that time matters and appending the elapsed time as a new message each turn (never by rewriting `system`) cut one Opus 5.5 agent's time by 47 percent and cost by 60 percent for 4.1 points of score. A tradeoff lever; measure it like effort.
43. Task budgets (beta `task-budgets-2026-03-13`) give a token ceiling the model sees and paces against. They are advisory; `max_tokens` remains the cap. Minimum 20,000. Set from the 90th percentile of the loop, then tighten, once, on the first request, and leave `remaining` unset unless you rewrite history. A very tight budget can read as refusal. Not during a migration until the value is known. Not on interactive Sonnet 5.5 sessions: the countdown arrives as a system message after every tool result and reads as prompt injection; keep budgets for unattended loops. Rejected with a compaction block when `remaining` is sent. A Managed Agents session budget is a hard dollar stop, and a workspace spend limit is the last backstop.
44. Count tokens with `POST /v1/messages/count_tokens` and the same model id as inference. Never `tiktoken`: it undercounts Claude by about 15 to 20 percent on text and more on code. Counting is stateless and rejects server tools. Opus 4.7 and later, including the whole 5 family, use a newer tokenizer that produces about 30 percent more tokens than earlier models for the same text (1x to 1.35x, text dependent); a move within that group (Opus 4.8 to Fable 5.1) is roughly flat. Re-baseline after a model change.

## Measuring

45. Baseline cost per task from logged `usage`, per traffic class, with the four meters each at its own rate: input, cache write, cache read, output. A blended number across classes means nothing. The zero token source for the org wide baseline is the Admin API: `GET /v1/organizations/usage_report/messages` and `cost_report`, grouped by model and workspace, or the newer Usage and Cost Analytics API (beta `analytics-usage-cost-2026-08-24`), which also filters by API key and user; the older report is now legacy. Neither covers Bedrock, Vertex or Foundry, and a key shared across projects blends them, so one key per project.
46. Fetch current pricing before writing a dollar figure. A remembered rate is not a source.
47. Per lever: re-run the eval and read pass rate and cost per task together against the last kept configuration. A lever that saves money and gives back accuracy is not an optimization, so revert it. Plot score against cost and take the Pareto frontier. Shadow run the winner, keep the eval running after cutover, and confirm the saving in usage reports.
48. A free win on a path no eval covers is measured on cost only, and said so. A tradeoff there stays a proposal.
49. Observability (beta): the SDKs emit OpenTelemetry spans in your process for every request and client tool, and the API can emit server side spans to a destination an admin adds (Claude API and Platform on AWS). Together they give per request token counts, latency and the tool tree in the backend you already run. The default content mode exports metadata only; turning on full content exports prompts and responses to that backend under its retention, so decide that deliberately and keep personal data and secrets out of `conversation_id`. Spans are the cheapest way to build an eval set from real traffic.

## Checklist

- [ ] Quality bar exists before any tradeoff
- [ ] Effort set explicitly on every route
- [ ] Effort swept before the model was changed, from the second request on, with the dial confirmed alive
- [ ] Strongest model at lower effort priced before a cascade
- [ ] Cost per completed task, per traffic class, from logged usage or the usage report
- [ ] One change per lever, kept or reverted on measured pass rate and cost over several runs
- [ ] Batch used for everything that can wait
- [ ] Re-swept after a model or prompt change
