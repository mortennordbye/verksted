# Tool use, structured output and context in code

As of 2026-10-16. Beta names and platform support change, so check `tool-use-concepts.md` and `platform-availability.md` in the `claude-api` skill before shipping.

## Choosing the surface

1. Start simple. A single call fits classification, summarizing, extraction and Q and A. A workflow, where your code owns the steps, fits a known multi step pipeline. An agent, where the model chooses the steps, is for open ended work.
2. Build an agent only if all four hold: the task is multi step and hard to specify in advance, the outcome is worth the cost and latency, the model is capable at this kind of task, and errors can be caught and recovered (tests, review, rollback).
3. Four ways to run an agent. The harness is the loop and context handling. The deployment is where it runs.
   - Manual loop: you write the `stop_reason == "tool_use"` loop. You own everything.
   - Tool Runner (`client.beta.messages.tool_runner`): the SDK loops over tools you define. Harness only, you host. Default for a custom tool agent.
   - Managed Agents (beta): Anthropic runs the loop and hosts a per session sandbox. Harness and deployment. Claude API and Platform on AWS only.
   - Claude Agent SDK: the Claude Code harness as a library, with built in file, bash and search tools, hooks, subagents and sessions. Harness only, you host. A separate product from the Tool Runner.
4. Each Tool Runner iteration yields the assistant message before tools run, so you can gate or approve in the tool function, override the pending request, intercept errors, change results (for example add `cache_control`), bound the loop with `max_iterations`, stream, and compact. "I need control" is rarely a reason for a manual loop. Use a manual loop only to own the whole loop: a custom transport, request shapes the SDK cannot build, avoiding the beta dependency, or interleaving other work mid loop.
5. A manual loop runs until `stop_reason == "end_turn"`, always appends the full `response.content`, and matches every `tool_result` to its `tool_use_id`.
6. Managed Agents suits a stateful agent with a workspace, persisted versioned configs, long sessions, scheduled runs and a deliverable that must meet a rubric. Create the agent once, store its id, and start sessions from it. Never create agents in the request path.
7. Validate inputs and gate destructive operations behind human approval, in the runner and in a manual loop.

## Designing the tool surface

8. Bash gives breadth but the harness sees an opaque string. A dedicated tool has typed arguments you can intercept, gate, render or audit. Start with bash and promote an action to its own tool when it needs gating on a security boundary (reversibility is the test: `send_email` is gateable, `bash -c "curl -X POST"` is not), a staleness check (an `edit` tool that rejects a write if the file changed), custom rendering, or scheduling (read only tools can run in parallel, bash cannot be told apart from `git push`).
9. Descriptions: be prescriptive about when to call. Recent Opus models reach for tools more conservatively and trigger conditions in the description measurably raise the call rate. Describe every property, use `enum` for fixed sets, mark only truly required parameters as required. At least 3 to 4 sentences per tool. Specific names (`get_current_weather`, not `weather`), namespaced where there are many (`github_list_prs`).
10. Consolidate related operations into one tool with an `action` parameter. Return only high signal fields with stable identifiers, because bloated results waste context.
11. `input_examples` on a tool must validate against its schema (else 400) and cost about 20 to 50 tokens each for simple ones and 100 to 200 for complex ones. Not supported on server tools or computer use.
12. Steer triggering from the system prompt as behaviour ("investigate with the tools before responding") without naming a tool. A preference for one tool belongs in that tool's description (`prompt-structure.md`). A tool use system prompt of a few hundred tokens is added automatically.

## Results and calls

13. On failure return a `tool_result` with `is_error: true` and an informative message. The model usually acknowledges it and tries another way. Never drop a failed result.
14. Parallel calls are on by default. Run them concurrently and return all `tool_result` blocks in one user message. Splitting them across messages trains the model to stop calling in parallel. `disable_parallel_tool_use: true` allows at most one call.
15. Strict tool use: `strict: true` as a top level field on the tool, with `additionalProperties: false` and `required`. It guarantees the input validates. It is not compatible with programmatic tool calling.
16. Eager input streaming: on a streamed request with your own tools, set `eager_input_streaming: true` on each tool, so large inputs stream instead of arriving after a long silent buffer. It removes server side validation, so the client must:
    1. Validate the parsed input against the schema before running the tool. Typed helpers do this (TypeScript `betaZodTool`, Python typed `@beta_tool`, Java annotated classes, Go struct tags, Ruby `BaseTool`). TypeScript `betaTool()` and PHP `BetaRunnableTool` do not, so validate in `run`.
    2. Check `stop_reason == "max_tokens"` when a `tool_use` is present, since a truncated input often parses as a valid partial object. Retry with a higher `max_tokens`. Stop on `refusal` and never run that turn's tools.
    3. Catch only the SDK's JSON error, rethrow typed API errors, and cap retries.
    4. On a validation failure with the block in hand, return an `is_error` result carrying the raw input. If the SDK raised before the block completed there is no `tool_use_id`, so re issue the request.
    Leave it off for non streaming requests, server tools, and through a proxy or older Bedrock deployment that rejects the field.
17. `pause_turn`: the server side loop caps at 10 iterations. Resume by re sending the user message and the assistant `response.content`. Do not add a "Continue." message. Cap continuations (for example 5). The SDK tool runners do not resume automatically, so a paused turn ends the runner silently unless you restart it with the turn appended or use a manual loop.
18. Never match on the serialized tool input. Parse it with a JSON parser, because escaping differs between models.

## Server and client tools

19. Server tools (code execution, web search, web fetch) run on Anthropic's side. Declare them and results arrive as blocks in the same response. Use the latest type your model supports. `web_search_20260209` and `web_fetch_20260209` do dynamic filtering with code execution inside, so do not also declare `code_execution`. Web fetch only fetches URLs already in the conversation.
20. Code execution has no internet, about 5 GiB of RAM and disk, and containers that persist 30 days and can be reused by `container_id`. Sanitize any downloaded filename with `basename`.
21. Client tools (bash, text editor, memory, computer use) you execute. Bash and the text editor are schema less: declare the type and name, send no `input_schema`, and never define your own tool named `bash`.
22. Bash safety: treat every command as untrusted. Isolated environment, an allowlist of executables, reject shell operators, timeouts and resource limits, log every command. A blocklist is not enough.
23. Text editor safety: canonicalize the path and confine it to a project root, reject `..`, symlinks and encoded traversal, require `str_replace` to match exactly one occurrence.
24. Computer use now goes through `computer_toolset_20260801` (no `name`, no beta header, echo `toolset_name: "computer"` in results). Opus 5.5, and Sonnet 5.5 on the Claude API and Google Cloud, accept only the toolset. The older `computer_20251124` is beta and the two forms cannot share a request.
25. MCP connector (beta `mcp-client-2025-11-20`) needs both halves: `mcp_servers` and a matching `mcp_toolset` entry. Either alone is a validation error.
26. Advisor tool (beta `advisor-tool-2026-03-01`, Claude API and Platform on AWS): `{"type": "advisor_20260301", "name": "advisor", "model": ...}`. The advisor must be at least as capable as the executor or it is a 400. Sonnet 5.5 as executor rejects Opus 4.8, 4.7, 4.6, Sonnet 5 and Sonnet 4.6 as advisors. Switch on the result's content type: `advisor_result` has plaintext, `advisor_redacted_result` has `encrypted_content` you can only replay, `advisor_tool_result_error` has an `error_code`. Append the full `response.content` including advisor blocks on later turns. Removing the tool while history holds advisor results is a 400.

## Scaling tools and context

27. Programmatic tool calling lets the model write a script in the code execution container that calls your tools, so intermediate results never enter its context and only the final output returns. Use it for many sequential calls or large intermediate results. Declare `code_execution_20260120` and set `allowed_callers` on your tool. The reply to a pending call contains only `tool_result` blocks. Not on Bedrock or Vertex.
28. Tool search with `defer_loading: true` suits many tools with few relevant per request. Discovered schemas are appended, so the cache survives. Never defer every tool, and never defer the search tool itself.
29. Tool search is for discovery (the model decides). Mid conversation tool changes are for control (your app decides): the tool must already be declared with `defer_loading: true`, a removal sits right before an assistant message or last, and to change a definition send a removal first. Not on Sonnet 5 or Foundry.
30. Agent Skills through the Messages API: `container={"skills": [...]}` plus the code execution tool and beta `code-execution-2025-08-25`. This is not Managed Agents.
31. Context editing clears stale tool results or thinking blocks (beta `context-management-2025-06-27`, strategies `clear_tool_uses_20250919` and `clear_thinking_20251015`). Compaction summarizes into a server side block when the conversation nears the window (beta `compact-2026-01-12`). Append `response.content`, not just the text, or the compaction state is lost. Memory is for persistence across sessions. Many long running agents use all three.
32. The memory tool is client side over a `/memories` directory with `view`, `create`, `str_replace`, `insert`, `delete`, `rename`. Never store secrets, take care with personal data, and use a directory per user in a multi user system.
33. Citations: `citations: {enabled: true}` on every document block, or none. Incompatible with `output_config.format`.
34. Documents and images: put a PDF before the text block. Use the Files API (`file_id`) for the same file across requests, and match the block type to the file's type.

## Structured outputs

35. Two features: JSON outputs with `output_config.format` (`json_schema`), and strict tool use. Prefer `client.messages.parse()` where the SDK has it, which validates against your schema. The old `output_format` is deprecated.
36. Supported schema: object, array, string, integer, number, boolean, null, `enum`, `const`, `anyOf`, `allOf`, `$ref`, common string formats, and `additionalProperties: false` which is required on every object. Not supported: recursive schemas, `minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, complex array constraints, external `$ref`, lookaround in regex. `minItems` is 0 or 1 only. The Python and TypeScript SDKs strip unsupported constraints and validate them on the client.
37. Required properties are output first. If order matters mark all of them required. Compare enum values case insensitively.
38. A schema field asking for reasoning can trigger a `reasoning_extraction` refusal. A refusal can return output that does not match the schema, and `max_tokens` can leave it incomplete, so check `stop_reason` first.
39. The first request with a new schema is slower while the grammar compiles. It is cached 24 hours. Changing only `name` or `description` does not invalidate that. Changing the format does invalidate the prompt cache.
40. Per request limits across strict schemas: 20 strict tools, 24 optional parameters, 16 `anyOf` or type array parameters. Combining strict tools with JSON output can make the model answer with a tool call instead of JSON.
41. Use `output_config.format` for judge calls, not "respond with only JSON", which breaks on unescaped quotes.

## Checklist

- [ ] Surface chosen on the four agent criteria, Tool Runner unless there is a stated reason
- [ ] Tool descriptions say when to call, every property described
- [ ] Failed tools return `is_error`, parallel results in one message
- [ ] Eager streaming paired with client side validation and `max_tokens` check
- [ ] `pause_turn` resumed with a cap
- [ ] Bash and file tools confined and logged
- [ ] Structured output schema within the supported subset
