import { describe, expect, it } from "vitest";
import {
  consumeChunk,
  liveView,
  newStreamState,
  parseStream,
  timingOf,
  toolDetail,
} from "../src/assistant-stream.js";

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

function toolResult(id: string, content: unknown[]): string {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, content }] },
  });
}

const PNG = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

describe("screenshots", () => {
  it("keeps a picture a tool returned, on the turn that talks about it", () => {
    const out = parseStream(
      [
        INIT,
        assistant([{ type: "tool_use", id: "t1", name: "mcp__browser__browser_take_screenshot" }]),
        toolResult("t1", [{ type: "text", text: "Took a screenshot" }, PNG]),
        assistant([{ type: "text", text: "Here is the form." }]),
        result(),
      ].join("\n"),
    );

    expect(out.entries).toEqual([
      {
        role: "assistant",
        text: "Here is the form.",
        tools: [{ name: "mcp__browser__browser_take_screenshot", detail: "" }],
        shots: [{ mediaType: "image/png", data: "iVBORw0KGgo=" }],
      },
    ]);
  });

  it("leaves out what Read returned, and anything that is not a raster picture", () => {
    // Read hands back the image you attached, which is already on screen.
    const out = parseStream(
      [
        INIT,
        assistant([
          { type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x.png" } },
          { type: "tool_use", id: "s1", name: "mcp__browser__browser_take_screenshot" },
        ]),
        toolResult("r1", [PNG]),
        toolResult("s1", [
          {
            type: "image",
            source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
          },
        ]),
        assistant([{ type: "text", text: "Done." }]),
        result(),
      ].join("\n"),
    );

    expect(out.entries[0]).not.toHaveProperty("shots");
  });

  it("does not lose a screenshot the run died after", () => {
    const out = parseStream(
      [
        INIT,
        assistant([{ type: "tool_use", id: "t1", name: "mcp__browser__browser_take_screenshot" }]),
        toolResult("t1", [PNG]),
      ].join("\n"),
    );

    expect(out.entries.at(-1)?.shots).toHaveLength(1);
  });
});

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

  it("says why a run failed when the reason is only under `errors`", () => {
    // What the CLI prints when it never reached the model: no `result` at all.
    const out = parseStream(
      [
        INIT,
        result({
          subtype: "error_during_execution",
          is_error: true,
          result: undefined,
          errors: ["No conversation found with session ID: abc"],
        }),
      ].join("\n"),
    );

    expect(out.error).toBe("No conversation found with session ID: abc");
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

/** One token-level event, as `--include-partial-messages` prints it. */
function partial(event: unknown): string {
  return JSON.stringify({ type: "stream_event", event });
}

describe("a turn in flight", () => {
  it("shows what it is thinking and the tool it is reaching for, before either is done", () => {
    const reached: string[] = [];
    const state = newStreamState((name) => reached.push(name));
    const lines = [
      partial({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Check " },
      }),
      partial({
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "the site." },
      }),
      partial({
        type: "content_block_start",
        content_block: { type: "tool_use", name: "WebFetch" },
      }),
    ];

    expect(consumeChunk(lines.join("\n") + "\n", state)).toEqual([]);
    expect(liveView(state)).toEqual({
      text: "",
      thinking: "Check the site.",
      tools: [{ name: "WebFetch", detail: "" }],
    });
    // Told as the call starts, not once it is complete: the taint rule wants it
    // before anything the call brings back can be acted on.
    expect(reached).toEqual(["WebFetch"]);
  });

  it("swaps the half-written call for the finished one, then clears once something is said", () => {
    const state = newStreamState();
    consumeChunk(
      [
        partial({
          type: "content_block_delta",
          delta: { type: "thinking_delta", thinking: "Hm." },
        }),
        partial({
          type: "content_block_start",
          content_block: { type: "tool_use", name: "WebFetch" },
        }),
        assistant([
          { type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://pao.no" } },
        ]),
      ].join("\n") + "\n",
      state,
    );
    expect(liveView(state).tools).toEqual([{ name: "WebFetch", detail: "https://pao.no" }]);

    const said = consumeChunk(assistant([{ type: "text", text: "Booked out." }]) + "\n", state);

    expect(said.map((e) => e.tools)).toEqual([[{ name: "WebFetch", detail: "https://pao.no" }]]);
    expect(liveView(state)).toEqual({ text: "", thinking: "", tools: [] });
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

describe("where a turn's wait went", () => {
  it("reads the init, the first token, each tool's time and the cache off the stream", () => {
    let clock = 1_000;
    const state = newStreamState(undefined, () => clock);
    const feed = (at: number, event: unknown) => {
      clock = at;
      consumeChunk(`${JSON.stringify(event)}\n`, state);
    };

    feed(1_500, {
      type: "system",
      subtype: "init",
      mcp_servers: [{ name: "verksted", status: "connected" }],
    });
    feed(2_000, {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hm" } },
    });
    feed(2_500, {
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "tool_use", name: "WebFetch" } },
    });
    feed(3_000, {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: {} }] },
    });
    // A string result is still a result, though it carries no picture.
    feed(3_400, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "page" }] },
    });
    feed(4_000, {
      type: "result",
      subtype: "success",
      usage: { input_tokens: 1, cache_read_input_tokens: 90, cache_creation_input_tokens: 5 },
    });

    expect(timingOf(state, 1_000)).toEqual({
      init: 500,
      firstToken: 1_000,
      firstTool: 1_500,
      total: 3_000,
      servers: [{ name: "verksted", status: "connected" }],
      tools: [{ name: "WebFetch", ms: 400 }],
      cacheRead: 90,
      cacheWrite: 5,
    });
  });

  it("leaves what never happened null, for a turn that died early", () => {
    const state = newStreamState(undefined, () => 5);
    expect(timingOf(state, 5)).toMatchObject({ init: null, firstToken: null, tools: [] });
  });
});

describe("a job answering to a schema", () => {
  it("records what the result carries as its words, with no tool shown for it", () => {
    const state = newStreamState();
    consumeChunk(
      `${assistant([{ type: "tool_use", id: "t1", name: "StructuredOutput", input: {} }])}\n`,
      state,
    );
    const answer = { rules: [{ slug: "a", rule: "b" }] };

    const [entry] = consumeChunk(
      `${JSON.stringify({ type: "result", subtype: "success", structured_output: answer })}\n`,
      state,
    );

    expect(entry.text).toBe(JSON.stringify(answer));
    expect(entry.tools).toEqual([]);
    expect(state.pendingTools).toEqual([]);
  });

  it("ignores it on a failed run", () => {
    const state = newStreamState();

    const got = consumeChunk(
      `${JSON.stringify({ type: "result", is_error: true, result: "no", structured_output: {} })}\n`,
      state,
    );

    expect(got).toEqual([]);
    expect(state.error).toBe("no");
  });
});

describe("a thread being summarised", () => {
  it("leaves a mark saying so, and the smaller size is what the next turn carries", () => {
    const state = newStreamState();

    const [entry] = consumeChunk(
      `${JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "manual", pre_tokens: 123_456, post_tokens: 4_321 },
      })}\n`,
      state,
    );

    expect(entry.tools).toEqual([{ name: "compacted", detail: "123k to 4k tokens" }]);
    expect(state.context).toBe(4_321);
  });
});
