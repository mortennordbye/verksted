import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { headroomCommand, turnEnv } from "./assistant-policy.js";
import * as logeverylift from "./logeverylift-auth.js";

/**
 * The backend talking to a connector's MCP server itself, for the one thing a turn
 * may not do: a write the person has tapped a card for.
 *
 * A connection per call. These are a person's taps, and headroom's server is a
 * process that would otherwise sit there holding its password.
 */
const CALL_MS = 60_000;

export class ConnectorError extends Error {}

async function transportFor(connector: string): Promise<Transport> {
  if (connector === "headroom") {
    const { command, args } = headroomCommand();
    const env = await turnEnv(true);
    return new StdioClientTransport({ command, args, env, stderr: "ignore" });
  }
  if (connector === "logeverylift") {
    const token = await logeverylift.accessToken();
    if (!token) throw new ConnectorError("LogEveryLift is not signed in");
    return new StreamableHTTPClientTransport(new URL(logeverylift.MCP_URL), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
  }
  throw new ConnectorError(`no such connector: ${connector}`);
}

async function withClient<T>(connector: string, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "verksted", version: "1" });
  await client.connect(await transportFor(connector), { timeout: CALL_MS });
  try {
    return await use(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** A tool as its server describes it now, or null if it has no such tool. */
export function describeTool(
  connector: string,
  tool: string,
): Promise<{ required: string[] } | null> {
  return withClient(connector, async (client) => {
    const { tools } = await client.listTools(undefined, { timeout: CALL_MS });
    const found = tools.find((t) => t.name === tool);
    return found ? { required: found.inputSchema.required ?? [] } : null;
  });
}

/** Run a tool, and say what it answered. An error it reports is thrown. */
export function callTool(
  connector: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  return withClient(connector, async (client) => {
    const res = await client.callTool({ name: tool, arguments: args }, undefined, {
      timeout: CALL_MS,
    });
    const content = Array.isArray(res.content) ? (res.content as { text?: string }[]) : [];
    const text = content.map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new ConnectorError(text.slice(0, 500) || "the tool reported an error");
    return text;
  });
}
