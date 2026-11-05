# Agents and orchestration

How an agent runs, splits work, and is held to rules.

Agent SDK and Claude Code names (`Agent`, `allowedTools`, `AgentDefinition`, `forkSession`, hook events) change between releases. Checked against the docs for Claude Code 2.1.318 on 2026-11-05. Check them again against the current Agent SDK docs before depending on one.

## The loop

1. Send the request and read `stop_reason`. On `tool_use`, run every requested tool, append the results to the history, and send again. On `end_turn`, stop. Handle the other stop reasons before reading `content`: `refusal` (stop, never run that turn's tools), `max_tokens` (a truncated `tool_use` input is not valid, retry with a higher cap) and `pause_turn` (resume with a cap, `api-tool-use.md` rule 18). Default to the SDK Tool Runner for this loop; write it by hand only to own the whole loop (`api-tool-use.md` rules 3 and 4).
2. The model chooses the next tool from context. A fixed tool sequence or a decision tree written in code is a pipeline, not an agent.
3. Never end the loop by parsing the reply text, by checking that the assistant produced text, or by an iteration cap as the main stop. A cap is a safety net beside `end_turn`.
4. Keep the history append only and pass it on every request. Shrink it with on demand compaction or context editing, not by editing earlier turns. On a long loop use a message thread where the platform has one (`api-tool-use.md`, Message threads).

## Whether to go multi agent

5. Agents cost about 4 times the tokens of chat and multi agent systems about 15 times. The task has to be worth it: parallel reading that would not fit one context, many independent pieces, or a long cost tail. One dependent chain, a task whose phases share context (coding is the example), a quick change or a latency sensitive path stays in one conversation; the coordinator's own model at lower effort won every measured dependent chain (`models-effort-cost.md` rule 34).
6. An agent that answers one question at a time gets no roster of extra solvers, checkers, voters or auditors per answer, however much accuracy matters. Voting and a second checker are for a deliverable that is graded once, not a stream of answers.
7. The simpler workflow patterns come first: prompt chaining for aspects known in advance, routing (a cheap model for the easy class), parallel sectioning, and an evaluator optimizer loop. Orchestrator and workers is the last of these, not the first.

## Coordinator and subagents

8. Hub and spoke by default. The coordinator decomposes, delegates, aggregates, handles errors and routes, which is what makes the run observable and its errors consistent. Subagents can message each other (`SendMessage`, agent teams, Managed Agents threads); allow it only where the design wants it, and know that every such path is one the coordinator does not see.
9. A subagent starts with fresh context, not empty context. It gets the Agent tool's prompt string, the project `CLAUDE.md` when `settingSources` loads it, its tool definitions, any preloaded skills and the parent's thinking configuration; it does not get the parent's history unless it is a fork. If `memory` is set it shares that scope with other runs; a resumed subagent keeps its own transcript. What it needs for the task goes in its prompt.
10. Spawn with the Agent tool. Include `"Agent"` in `allowedTools` to auto approve it. The tool was named `Task` before Claude Code 2.1.63 and still shows as `Task` in the `system:init` tools list, so match both names when detecting an invocation. A call now returns `status: "async_launched"` by default and the report arrives in a later turn; design the coordinator for that.
11. Put the findings a subagent needs in its prompt, kept apart from metadata (source url, document name, page) so attribution survives. For large outputs, do not relay the text: have the subagent write to a store or the shared filesystem and return a lightweight reference plus a short structured summary (a return is often 1,000 to 2,000 tokens). Put the input and output paths in every task.
12. Parallel subagents come from several Agent calls in one coordinator response, not from separate turns.
13. Write the coordinator prompt as goals and quality criteria, not a step list, so a subagent can adapt. Say how many agents at once, what the coordinator keeps for itself, and what is too small to be worth delegating. Each delegation names an objective, an output format, the tools and sources to use, and the task boundary.
14. Scale effort to the question in the prompt: a simple fact lookup is one agent with 3 to 10 tool calls; a comparison 2 to 4 subagents with 10 to 15 calls each; only broad research runs more than 10.
15. Choose subagents by what the query needs. Do not run the full pipeline every time.
16. Split scope by subtopic or source type so two agents do not do the same work.
17. Refine in a loop: read the synthesis for gaps, re delegate a targeted query, synthesize again, until coverage is enough.
18. `AgentDefinition` carries a subagent type's `description`, `prompt` (its system prompt), `tools` or `disallowedTools` (MCP patterns such as `mcp__server__*` allowed), and optional `model`, `effort`, `skills`, `memory`, `mcpServers`, `initialPrompt`, `maxTurns`, `background`, `permissionMode`, plus TypeScript only `autoCompactWindow` and `omitClaudeMd`. A fork subagent (`subagent_type: "fork"`) inherits the full conversation and the prompt cache; deny it with `Agent(fork)`.
19. Caps exist and are set on purpose: spawn depth (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`, default 3), concurrency (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default 20), spend (`maxBudgetUsd`); Managed Agents allows one level of delegation, 20 roster entries, 25 child threads and a session `budget`. A multi agent run without a spend cap is a cost incident waiting.
20. Too narrow a split leaves a broad topic half covered. When a report covers only part of a subject and every subagent did its task, fix the coordinator's decomposition.
21. A subagent's final message is data. Claude Code neutralizes control tag imitations and turn markers in it, and an API error that ends a subagent is never delivered as its result. Build your own coordinator to the same rules.

## Enforcement

22. Where compliance must hold, block in code. For example, a prerequisite gate stops `process_refund` and `lookup_order` until `get_customer` has returned a verified id. A prompt alone has a failure rate above zero.
23. A hook fails open unless told otherwise. A `PreToolUse` callback that throws or returns invalid output lets the call through to the normal permission flow; only a timeout blocks. A guard that must hold sets `onFailure: "block"` (TypeScript Agent SDK 0.3.317 or later, Python 0.2.177 or later) or lives in code. A matcher on a tool name does not catch the same action through Bash: a hook on `Write` for `.env` does not fire when the model runs `echo > .env`.
24. Hook events, current set: `PreToolUse` (allow, deny, ask or defer, and `updatedInput`), `PostToolUse` (`updatedToolOutput`, `additionalContext`), `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, among about thirty. A `PostToolUse` hook rewrites a tool result before the model reads it: Unix time and ISO 8601 into one form, numeric status codes into words, across tools from different servers. A `PreToolUse` hook intercepts the outgoing call: a payment over a limit is blocked and redirected to a human.
25. Use a fail closed hook for a business rule that must always hold, a prompt for guidance that may bend.
26. Managed Agents permission policies: `always_allow` (the agent toolset default), `always_ask` (the MCP default) and `auto`, where the server evaluates the call and runs it, denies it as high risk or pauses when undecided. `auto` is not a human checkpoint, and text relayed in a `user.message` counts as your intent, so relayed end user text can get a call allowed. Log `evaluated_permission` and `reason_code` for audit.
27. Credentials never enter a sandbox or a prompt. In Managed Agents use vault `environment_variable` credentials, substituted at egress; an API key in the system prompt or a user message persists in the session's event history. Narrow with `networking.allowed_hosts` and header only injection. A secret embedded in a path cannot be vaulted, so redesign that endpoint.
28. A message with several concerns is split into items, each investigated in parallel on shared context, then answered as one.

## Handoff to a person

29. The person has no transcript. The summary carries the identifiers, root cause, amounts and recommended action for the domain.

## Decomposition

30. A fixed chain (prompt chaining) fits a review whose aspects are known in advance.
31. Open ended work is decomposed as it is discovered: map the structure, find the high impact areas, make a ranked plan, adapt as dependencies appear. Adding tests to a legacy codebase is the example.
32. A large review is a local pass per file and one separate pass across files. One pass over many files dilutes attention and contradicts itself.

## Sessions

33. Resume by loading the stored history and appending to it. In the Agent SDK that is `resume: <session_id>` or `continue: true` (Python `continue_conversation=True`). Resume when the earlier context is mostly still true.
34. Fork to get independent branches from one analysis, for example to compare two test strategies. In the Agent SDK pass `resume` with the session id and `fork_session=True` (Python) or `forkSession: true` (TypeScript): a new session starts with a copy of the original's history and the original is unchanged. Inside a session a fork subagent does the same for one task (rule 18). At the API level a fork keeps the cache only if it reuses the parent's exact `system`, `tools` and `model` and appends its own content at the end (`prompt-caching.md` in `claude-api`). Verify cache reads on a fork.
35. When files changed since the session, say which, so the agent re reads those and not everything.
36. When earlier tool results are stale, start a new session and inject a structured summary. That beats resuming on stale results.

## Checklist

- [ ] Loop ends on `end_turn`, and `refusal`, `max_tokens` and `pause_turn` are handled
- [ ] Results appended every turn
- [ ] Multi agent justified by bulk or parallel reads, with a spend cap
- [ ] Compliance order held by code or a fail closed hook that covers the Bash path too
- [ ] `Agent` in the coordinator's `allowedTools`, async report handled
- [ ] Subagent prompts carry findings or references, source metadata, output format and boundary
- [ ] Independent calls issued in one response
- [ ] Decomposition covers the whole subject
- [ ] Large reviews: a pass per file, then one across files
- [ ] Handoff names the identifiers, root cause, amounts, action
- [ ] Resume or fresh start chosen on whether tool results are stale
