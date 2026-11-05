# Tools and MCP

How tools are described, fail, and are scoped.

Not date checked. Before relying on an MCP field or SDK built in tool name, check it against the `claude-api` skill and the current MCP docs.

## Descriptions

1. The description is what the model selects a tool by. A one line description among similar tools gives unreliable selection.
2. State the input format, an example query, the edge cases, and where this tool stops and a similar one starts.
3. Overlapping descriptions misroute. `analyze_content` beside `analyze_document` is a typical pair.
4. Remove overlap by renaming (`analyze_content` becomes `extract_web_results`) or by splitting a generic tool into purpose built ones with their own input and output contract (`analyze_document` becomes `extract_data_points`, `summarize_content`, `verify_claim_against_source`).
5. A keyword in the system prompt can pull a request toward the wrong tool and override a good description. Read the system prompt for them.
6. The first step for a misrouted tool is the description. Few-shot examples, a keyword router and merging tools all cost more.

## Errors

7. Return failure with MCP `isError` from an MCP server. In a Messages API tool loop the same signal is `is_error: true` on the `tool_result` (see `api-tool-use.md`).
8. Classes: transient (timeout, service down), validation (bad input), business (policy), permission.
9. Return `errorCategory` (transient, validation, business, permission), `isRetryable`, and a description a person can read. A business rule violation is `isRetryable: false` with an explanation fit to show a customer.
10. "Operation failed" removes every recovery choice. Never return it.
11. A failed access and a valid empty result are different. A query with no matches succeeded.
12. A subagent retries a transient failure itself. It passes on only what it could not resolve, with the partial results and what it tried.

## How many tools, and which

13. Eighteen tools select worse than four or five.
14. An agent given a tool outside its role uses it. A synthesis agent with web search will search.
15. Scope tools to the role. Allow a narrow cross role tool for a frequent need: a `verify_fact` on the synthesis agent for the simple lookups, with the hard ones still going through the coordinator. When most checks are simple, sending every one through the coordinator costs latency for no gain.
16. Replace a generic tool with a constrained one: `fetch_url` becomes `load_document`, which validates the url.

## tool_choice

17. `auto`: the model may answer in text and call nothing.
18. `any`: the model must call some tool, its pick. Use it to rule out a text reply.
19. `{"type":"tool","name":"..."}`: that tool is called. Use it to run `extract_metadata` first. The later steps are later turns.
    Both return 400 on some current models. `api-behavior.md` rules 9 to 11 own the model list and the replacement, so read them before setting either.

## MCP in an app

20. Every configured server's tools are found at connect time and are available together, so the tool count adds up across servers. Scope each agent to the tools its role needs.
21. An MCP resource exposes a catalog (issue summaries, a docs tree, a database schema) so the agent makes fewer exploratory calls.
22. Write MCP tool descriptions well enough that the agent does not reach for a built in tool like Grep when the MCP tool does more.
23. Use a community server for a standard integration such as Jira. Write a custom server only for what is specific to the team.
24. Credentials come from the environment (`${GITHUB_TOKEN}` expansion in an MCP config file), never from a committed file. Where a runtime reads a project level `.mcp.json` and a user level `~/.claude.json`, the project file is shared and the user file is personal, and both are live at once.
25. Through the Messages API itself an MCP server needs both halves: `mcp_servers` and a matching `mcp_toolset` entry. See `api-tool-use.md`.

## Agent SDK built in tools

26. Grep searches contents (function names, error text, imports, callers). Glob matches paths. Read and Write take a whole file. Edit changes one place by a unique match, and falls back to Read plus Write when the match is not unique.
27. Learn a codebase in steps: Grep for entry points, Read to follow imports. To trace use through wrappers, list the exported names first, then search each.

## Checklist

- [ ] Each description has input format, example, edge cases, boundary against neighbours
- [ ] No two tools overlap
- [ ] Four or five tools per agent, scoped to the role
- [ ] `isError`, `errorCategory`, `isRetryable` and a readable message on every failure
- [ ] Empty result and failed access told apart
- [ ] `tool_choice` set on purpose, and not `any` or a named tool on models that return 400
- [ ] MCP config carries no secret
