/**
 * What a tool call is called on screen. The names belong to the CLI and to each
 * MCP server, and `mcp__browser__browser_navigate` is not something to read on a
 * phone. Anything without a name here falls back to its own words, so a new tool
 * reads plainly without anyone having to list it.
 */
const NAMED: Record<string, string> = {
  WebFetch: "read a page",
  WebSearch: "searched the web",
  Read: "read a file",
  Grep: "searched files",
  Glob: "listed files",
  convene: "asked",
  discuss: "round table",
  everyone: "asked everyone",
};

const SERVERS: Record<string, string> = {
  headroom: "finances",
  logeverylift: "training",
  browser: "browser",
  verksted: "",
};

export function toolLabel(name: string): string {
  const known = NAMED[name];
  if (known) return known;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  const server = mcp?.[1] ?? "";
  const words = (mcp?.[2] ?? name)
    .replace(new RegExp(`^${server}_`), "")
    .replace(/^(get|list|query)_/, "")
    .replaceAll("_", " ");
  const from = SERVERS[server] ?? server;
  return from ? `${from}: ${words}` : words;
}
