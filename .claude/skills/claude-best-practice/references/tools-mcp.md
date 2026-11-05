# Tools and MCP

How tools are described, what they return, how they fail, and how they are scoped.

Design rules checked against the MCP specification, the Claude Code docs and Anthropic's tool writing posts on 2026-11-05. Before relying on an MCP field or SDK built in tool name, check it against the `claude-api` skill and the current MCP docs.

## Descriptions

1. The description is what the model selects a tool by. A one line description among similar tools gives unreliable selection.
2. State when to call it, the input format, an example query, the edge cases, and where this tool stops and a similar one starts. A stated trigger condition measurably raises the call rate on recent models (`api-tool-use.md` rule 9).
3. Overlapping descriptions misroute. `analyze_content` beside `analyze_document` is a typical pair.
4. Remove overlap by renaming (`analyze_content` becomes `extract_web_results`) or by splitting a generic tool into purpose built ones with their own input and output contract (`analyze_document` becomes `extract_data_points`, `summarize_content`, `verify_claim_against_source`).
5. A keyword in the system prompt can pull a request toward the wrong tool and override a good description (an observed failure, not a documented rule). Read the system prompt for them.
6. The first step for a misrouted tool is the description; the second is `input_examples` (1 to 5, which took complex parameter accuracy from 72 to 90 percent in Anthropic's measurement) and `strict: true` for schema valid arguments. A keyword router and merging tools cost more.
7. Make arguments hard to get wrong: absolute paths over relative, no formats that need line counting or escaping, ids resolved to names where the model has to reason about them. Anthropic reports spending more time on tool ergonomics than on the prompt.

## What a tool returns

8. Return what the model needs to reason, in the words it reasons in. Natural language over low level identifiers (`uuid`, `mime_type`) unless an id is needed for a later call, and then both.
9. Give the agent a size dial: a `response_format` enum (`concise`, `detailed`), pagination, a range or filter, and truncation with a sentence that says what was cut and how to get the rest.
10. Consolidate multi step operations into one tool (`schedule_event` in place of three lookups and a write) when the model always does them together.
11. Claude Code warns at 10,000 tokens of MCP output and caps at 25,000 (`MAX_MCP_OUTPUT_TOKENS`); text results past 50,000 characters are saved to a file. Design the result for that, do not rely on the harness to trim it.

## Errors

12. An MCP tool execution failure (API down, validation, policy) returns a result with `isError: true` and actionable feedback, which the client passes to the model. A protocol failure (unknown tool, malformed request) is a JSON-RPC error and never reaches the model as a result. In a Messages API tool loop the execution signal is `is_error: true` on the `tool_result` (see `api-tool-use.md`).
13. Classes: transient (timeout, service down), validation (bad input), business (policy), permission.
14. Return the class, whether a retry can help, and a description a person can read; a validation error includes a correctly formatted example of the input. The field names `errorCategory` and `isRetryable` are this skill's convention, not the MCP standard, which requires only `isError` and useful text. A business rule violation is not retryable and carries an explanation fit to show a customer.
15. "Operation failed" removes every recovery choice. Never return it.
16. A failed access and a valid empty result are different. A query with no matches succeeded.
17. A subagent retries a transient failure itself. It passes on only what it could not resolve, with the partial results and what it tried.

## How many tools, and which

18. More tools do not select better. Keep the 3 to 5 most used tools always loaded; past about 10 tools or 10K tokens of schemas, defer the rest behind tool search (`api-tool-use.md` rule 29). Claude Code and the Agent SDK already defer MCP tools and discover them on demand, so adding a server there costs little context; the Messages API needs `defer_loading` set by you.
19. An agent given a tool outside its role uses it. A synthesis agent with web search will search.
20. Scope tools to the role. Allow a narrow cross role tool for a frequent need: a `verify_fact` on the synthesis agent for the simple lookups, with the hard ones still going through the coordinator. When most checks are simple, sending every one through the coordinator costs latency for no gain.
21. Replace a generic tool with a constrained one: `fetch_url` becomes `load_document`, which validates the url.

## tool_choice

22. `auto`: the model may answer in text and call nothing. `none`: no call this turn. `disable_parallel_tool_use: true` with `auto` allows at most one call.
23. `any`: the model must call some tool, its pick. Use it to rule out a text reply.
24. `{"type":"tool","name":"..."}`: that tool is called. Use it to run `extract_metadata` first. The later steps are later turns.
    `any` and `tool` return 400 on Fable 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5. `api-behavior.md` rules 12 to 14 own the model list and the replacement, so read them before setting either.

## MCP in an app

25. An MCP resource exposes a catalog (issue summaries, a docs tree, a database schema) so the agent makes fewer exploratory calls. Server `instructions` are what the agent sees of a server under tool search, so write them.
26. Write MCP tool descriptions well enough that the agent does not reach for a built in tool like Grep when the MCP tool does more. Descriptions are capped (4,096 characters per tool in Claude Code, 16,384 for a server).
27. A server returns its tools in a deterministic order, so the prompt cache holds; use `structuredContent` with an `outputSchema` where the result is data, with the same JSON in a text block for older clients; treat tool `annotations` from a server as untrusted.
28. Use a community server for a standard integration such as Jira. Write a custom server only for what is specific to the team.
29. Credentials come from the environment (`${GITHUB_TOKEN}` or `${VAR:-default}` expansion in an MCP config file), never from a committed file. In Claude Code the project `.mcp.json` is shared, the user and local scopes live in `~/.claude.json`, a same named server resolves local over project over user with no field merge, and credential named variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `HTTPS_PROXY`, `NPM_TOKEN`) expand to empty in a remote server's `url` and `headers`. Managed Agents: vault credentials, `agent-orchestration.md` rule 27.
30. Through the Messages API itself an MCP server needs both halves: `mcp_servers` and a matching `mcp_toolset` entry. See `api-tool-use.md`.

## Agent SDK built in tools

31. Grep searches contents (function names, error text, imports, callers). Glob matches paths. On macOS, Linux and WSL both are off the default tool set and Claude searches through Bash with the bundled `grep` and `find`; they return when named in `--tools` or `--allowedTools`, when Bash is removed, or when a subagent lists them without Bash. Read and Write take a whole file. Edit changes one place by a unique match: when `old_string` matches more than once the model widens the match or sets `replace_all`, and on a stale match it reads the file again. There is no Write fallback.
32. Learn a codebase in steps: Grep for entry points, Read to follow imports. To trace use through wrappers, list the exported names first, then search each.

## Checklist

- [ ] Each description says when to call, input format, example, edge cases, boundary against neighbours
- [ ] No two tools overlap
- [ ] Results in the model's words, sized by the caller, truncated with a pointer
- [ ] 3 to 5 tools always loaded per agent, the rest deferred, scoped to the role
- [ ] Every execution failure carries class, retryability and a readable message
- [ ] Empty result and failed access told apart
- [ ] `tool_choice` set on purpose, and not `any` or a named tool on models that return 400
- [ ] MCP config carries no secret, tool order deterministic
