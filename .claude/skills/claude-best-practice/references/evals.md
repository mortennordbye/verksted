# Evals

As of 2026-11-05, from the `claude-api` eval guides and the live develop tests page. An eval is the quality bar every other decision here depends on: effort, model tier, prompt changes and cost cuts are all kept or reverted on it.

## What an eval is

1. Three things: a set of input examples, a way to run the app on each, and a way to grade each output. One flow per eval, never a grand unified benchmark.
2. Record the model, provider, system prompt, tools and output type. Exercise the real entry point, not a rebuilt API call. Stub tools only if they have side effects or depend on live state. For multi turn inputs grade the conversation outcome by default.
3. Get an explicit sign off on the inputs and on the grading method before running.

## Inputs

4. Sources in priority order: production transcripts or logs (check retention and personal data first, otherwise store ids and fetch at eval time, or anonymize, or rewrite synthetically; OpenTelemetry spans in full content mode are a ready made source), bug reports and tickets, 5 to 10 hand written examples, then synthesized from the codebase, which is the lowest fidelity.
5. Size 15 to 100 for a first eval that someone signs off case by case. Under 15 one flaky case swings the score. Past that, the live docs favour volume with automated grading over fewer hand graded cases: sets of a few hundred to a thousand where the grader is programmatic. The two agree once the grader is trusted; review the grader, not every case.
6. Ask where expected outputs came from, and when they were last verified. Gold taken from the model under comparison, such as the incumbent in a migration, rewards imitation, so use a rubric or pairwise judge.
7. Noise floor: the 95 percent half width on a pass rate is roughly `1/sqrt(n * reps)` (25 cases at 2 reps about 14 points, 100 at 2 about 7). Reps of the same case average out sampling noise but not which cases you picked, so add cases before adding reps, and quote the floor beside every delta.

## Grading, cheapest first

8. Programmatic check: exact or substring match, schema validity, a label from a closed set, a compile or test pass. For an agent that acts on an environment grade the end state in a disposable workspace, not the transcript. Add a no op detector.
9. Pairwise blind comparison: randomize A and B per case, allow `tie` and `both_bad`, treat candidates as untrusted data. If you will hill climb, freeze the baseline's outputs once and never regenerate the reference. It cannot see collapse across cases, so add a set level diversity metric if that is a risk.
10. Pointwise rubric with a model judge: Haiku 5.5 is cheap enough for every change, Sonnet 5.5 balanced, Opus 5.5 for nuanced criteria. Run the judge with thinking on. Do not use the model under test as its own judge, and for close calls use a different family or a small jury, since a judge prefers its own family. Use structured output. Write the rubric as concrete checkable claims, not "rate 1 to 5", and score independent properties as separate metrics, one judge call per property where you can. Aggregate to match the question: for a rare high stakes behaviour, fail on any or worst case, not a mean.
11. Human spot check for what a rubric cannot grade. It limits how often the eval can run.
12. A classification set with positives and negatives gets a confusion matrix, not one accuracy number.
13. Run the grader on a few cases and ask whether you would have scored any differently. One "yes" means the rubric is not ready. Check prompt and grader agree: if the prompt says "at least three" the grader must not pass only on more.

## Harness requirements

14. Bounded concurrency near the rate limit. Rows written as cases finish, with resume keyed on case and rep.
15. A hard per case wall clock limit, independent of stream liveness. Record a timeout, never a zero.
16. Jittered backoff on 429 and overloaded, a capped attempt count, the retry count recorded. A pass on retry counts as a fail, and every attempt's usage is counted.
17. Infrastructure errors go to a separate `errors.jsonl`, never into scores. Truncation is its own status and is left out of means. Refusals are their own metric. "No answer" is not "negative answer".
18. Assert the response `model` equals the requested model.
19. Take tokens from the API `usage` block, never string length. Derive cost from each row's model and usage at that model's rates, with the judge's cost separate. A cost of `$0.00` or a latency of `0.0` is a runner bug. For an agentic eval keep the per call breakdown, and keep the cache hit rate comparable across variants, or a cost delta is a caching artifact.
20. Latency covers the final successful request only, excluding retries, backoff and queueing. Report absolute numbers first, then relative change.
21. Estimate cost from a pilot's real usage, not from log surveys or dataset medians (2 to 4 times off, `claude-api` `evals/build-eval.md`) or guesses. Report min, median and max per case.
22. Before the first paid call: run an oracle that must pass and a null answer that must fail, an inverted item that must flip, send the judge an empty string, "I don't know" and a confident wrong answer, and confirm an induced API error lands as an error and not as `grade: 0`.
23. A clean isolated state per trial and deterministic setup. Eval config equals production config, including the API version the SDK sends. Save full trajectories. Run multiple trials and report intervals. Record an environment fingerprint (model, SDK, prompt hash, tool set) with every run.

## Is the eval any good

24. Task design: unambiguous success criteria, a reference solution that passes, re derive 10 labels yourself, record where ground truth came from and when it was checked, no annotation artifacts or label leakage, not answerable from memory, realistic distribution, both directions covered, one capability per case when diagnosing, headroom (a baseline near 95 percent or more cannot discriminate and about 0 percent is usually a case or grader bug). Report the majority class baseline.
25. At scale audit in three tiers: programmatic checks over all cases (duplicates, balance, lengths, schema), a stratified 20 to 50 close read, and a per case model auditor above a few hundred, with its cost quoted first.
26. Grader design: grades outcomes not paths, tolerant of whitespace and casing but a deliberately wrong answer must fail, cheat resistant, ground truth structurally out of the model's reach, deterministic or with measured variance. Spot check failures: if more than about 1 in 10 look like grader errors, fix the grader first. Partial credit must not make doing nothing optimal.
27. Judge specifics: randomize order, tell it not to reward length, do not call a response "reference", calibrate against human labels on a few dozen cases (agreement well under about 90 percent on clear cases means iterate the prompt), test on known negatives.
28. Can it detect the change: compare the noise floor with the headroom and with the smallest improvement worth shipping. If the floor is larger, say so with numbers and offer, in cost order: more reps, more cases, a pairwise or continuous metric, or trimming. The split is random and stratified by the first tag, never by baseline score, because selecting low scorers causes regression to the mean. Confirm the mechanism is wired: disable it and the score must drop. Recompute the headline from raw rows.

## Hill climbing a prompt or config against an eval

29. Needs a runnable eval that records, per case, the transcript, model, usage and grade from one call. Without one, build it first. If the thing under test is a generated artifact (a page, a document, code), rebuild the baseline 2 or 3 times first and measure build variance: three builds of one prompt spanned about 7 points against rescore noise near 1.4 in one run, and a climb under that variance measures nothing.
30. Ask for the goal (raise the metric, cut cost, cut latency, or move model). Every other metric becomes a must not regress guardrail. Record the off limits list as a hard constraint.
31. Stopping: plateau means improvement under a delta for at least 3 consecutive rounds, with the delta above the noise floor. A guardrail regression outside noise also stops it. Present the total cost, `(rounds + 1) * reps * cost per run`, from real usage and get a ceiling.
32. Split train and test, stratified, fixed once. The analyzer reads only train traces. Test is scored every round, never opened by the analyzer, picks the winner and is the headline. Small sets or cross case metrics get no split, and scores are labelled directional. About 150 or more cases can add a validation slice.
33. Each round: a fresh analyzer reads train traces only, proposes one hypothesis with a root fix and not a rewording, you apply it, run the full eval, and record. The analyzer generalizes: no train case nouns in the prompt it writes. Probe config levers on one case first. A round with a grossly different error profile is void and rerun. When time separates a round from the baseline, run a no change control and gate against the control, not the stale baseline.
34. Record two things per round, not one: did the mechanism engage (an engagement rate column) and did it help. An implausible judge graded jump is suspicious before it is good news; mark it `suspicious` and re grade before celebrating.
35. Overfit rules: train up and test flat means overfit, so revert. Train down and test up is noise, so keep only if it repeats. Ties go to the later round. End each kept round with a de fluff pass on the prompt and charge its tokens.
36. Before declaring a plateau by rule 31, after 2 to 3 rounds that clear no noise, stop and sort every remaining train failure: artifact gap (keep going), grader disagreement (fix the grader and re grade every variant), harness fault (fix it, exclude from the denominator), structural (reorganize), or variance (report best so far).
37. The final report leads with the test delta and its interval. If it is within noise, say so and recommend not merging.

## Cost driven search

38. Order: caching health, prompt audit, then a model and effort staircase, then a prompt climb on the frozen model, then one step down and left, then a final effort re sample, and multi model topologies last and usually never.
39. Staircase: enter at the highest cost plausible new generation tier at low effort. A pass steps down a tier. A fail steps right in effort, capped at 1 to 2 notches. Confirm the effort dial is alive on each model first (`models-effort-cost.md` rule 19), and read cost from the second request on, since each cell starts cache cold.
40. Pre register the quality floor, the cost margin and the mechanism you expect to see, before round 1, and a falsifier before any cleanup round. The confirm number is the headline, not the selection scores. Promotion needs at least 2 runs near the floor, since one winner scored 11 of 20 once and then 11, 6 and 11 (`evals/cost-hillclimb.md` in `claude-api`). Failures move between runs, so an effort cut is judged on aggregate non inferiority over several runs, never per case.
41. Findings: the cheapest configuration is often a stronger model at lower effort. Prompt wins are model specific. Cleaning a dated prompt can recover far more than a model swap alone. Census which instructions engage before trimming them. Charge each prompt edit its own token cost. A brevity cap saves through shorter replies, which is a quality tradeoff. A quality only climb raised cost per deliverable by 75 percent in one measured run (`evals/cost-hillclimb.md` in `claude-api`).
42. Prompt rounds win in rounds 1 and 2. In this cost driven search, stop after two consecutive non winners and cap at 3 to 4 rounds per model. Rule 31's three round plateau applies to a general hill climb.

## Checklist

- [ ] One flow, real entry point, sign off on inputs and grading
- [ ] Inputs from production or tickets first, at least 15, gold dated
- [ ] Cheapest grader that works, judge thinking on, not the model under test or its family alone
- [ ] Infra errors, truncation and refusals kept out of scores
- [ ] Cost from real usage, model asserted, cache hit rate comparable
- [ ] Noise floor below the smallest change worth shipping
- [ ] Train and test split before any hill climb, a control run when time has passed
- [ ] Engagement and effect recorded separately each round
