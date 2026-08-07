import { describe, expect, it } from "vitest";
import { parseStream, toolDetail } from "../src/assistant-stream.js";

/**
 * The CLI's stream-json shape belongs to the CLI, not to us, so these fixtures
 * are the contract: if a future release changes the events, this is where it
 * shows up rather than in an empty chat nobody can explain.
 */
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "5f81f371-3fa7-423f-820c-4a0fcffcfcfb",
  tools: ["Bash", "Read"],
});

function assistant(content: unknown[]): string {
  return JSON.stringify({
    type: "assistant",
    session_id: "5f81f371-3fa7-423f-820c-4a0fcffcfcfb",
    message: { content },
  });
}

function result(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "5f81f371-3fa7-423f-820c-4a0fcffcfcfb",
    ...extra,
  });
}

describe("parseStream", () => {
  it("reads the conversation id and one plain turn", () => {
    const out = parseStream(
      [INIT, assistant([{ type: "text", text: "Two things need you." }]), result()].join("\n"),
    );

    expect(out.conversationId).toBe("5f81f371-3fa7-423f-820c-4a0fcffcfcfb");
    expect(out.error).toBeNull();
    expect(out.entries).toEqual([{ role: "assistant", text: "Two things need you.", tools: [] }]);
  });

  it("attaches tool calls to the turn that finally says something", () => {
    // A tool-using turn arrives as several assistant events: the tool_use
    // first, the sentence that used it only after the result comes back.
    const out = parseStream(
      [
        INIT,
        assistant([{ type: "tool_use", name: "Bash", input: { command: "gh pr list" } }]),
        JSON.stringify({ type: "user", message: { content: [{ type: "tool_result" }] } }),
        assistant([{ type: "text", text: "Three PRs are open." }]),
        result(),
      ].join("\n"),
    );

    expect(out.entries).toHaveLength(1);
    expect(out.entries[0].text).toBe("Three PRs are open.");
    expect(out.entries[0].tools).toEqual([{ name: "Bash", detail: "gh pr list" }]);
  });

  it("keeps tool calls that were never followed by anything said", () => {
    const out = parseStream(
      [INIT, assistant([{ type: "tool_use", name: "Read", input: { file_path: "/data/x" } }])].join(
        "\n",
      ),
    );

    expect(out.entries).toEqual([
      { role: "assistant", text: "", tools: [{ name: "Read", detail: "/data/x" }] },
    ]);
  });

  it("surfaces a failed run rather than reporting an empty success", () => {
    const out = parseStream(
      [
        INIT,
        result({ subtype: "error_during_execution", is_error: true, result: "rate limited" }),
      ].join("\n"),
    );

    expect(out.error).toBe("rate limited");
    expect(out.entries).toEqual([]);
  });

  it("ignores lines that are not JSON and event types it does not know", () => {
    // A CLI that prints a deprecation warning to stdout, or adds an event type,
    // must not take the turn down with it.
    const out = parseStream(
      [
        "warning: something the CLI felt like saying",
        JSON.stringify({ type: "some_future_event", payload: 1 }),
        INIT,
        assistant([{ type: "text", text: "Still fine." }]),
        "{ truncated",
        result(),
      ].join("\n"),
    );

    expect(out.entries).toEqual([{ role: "assistant", text: "Still fine.", tools: [] }]);
    expect(out.error).toBeNull();
  });
});

describe("toolDetail", () => {
  it("picks the argument worth showing on a chip", () => {
    expect(toolDetail({ command: "make test" })).toBe("make test");
    expect(toolDetail({ file_path: "/data/repos/x/a.ts", content: "…" })).toBe(
      "/data/repos/x/a.ts",
    );
  });

  it("truncates rather than putting a whole file on a phone", () => {
    expect(toolDetail({ command: "x".repeat(200) })).toHaveLength(80);
  });

  it("says nothing when there is nothing worth saying", () => {
    expect(toolDetail(undefined)).toBe("");
    expect(toolDetail({ unexpected: 1 })).toBe("");
  });
});
