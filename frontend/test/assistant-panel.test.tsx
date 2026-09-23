import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantConfig } from "../../shared/api";
import { resetPollCache } from "../src/api";
import AssistantPanel from "../src/components/AssistantPanel";

let config: AssistantConfig;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  config = { name: "Ada", model: "opus", effort: "low", instructions: "" };
  fetchMock = vi.fn((url: string) => {
    if (url === "/api/assistant/config") return Promise.resolve(json(config));
    return Promise.resolve(json({ error: "no voice" }, 404));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const model = () => screen.getByLabelText<HTMLInputElement>("model");
const configReads = () =>
  fetchMock.mock.calls.filter(([url]) => url === "/api/assistant/config").length;

describe("the assistant's settings form", () => {
  // Saved back, last visit's settings would undo a change made on another device.
  it("fills from this visit's answer, not a remembered one", async () => {
    const first = render(<AssistantPanel />);
    await waitFor(() => expect(model().value).toBe("opus"));
    first.unmount();

    config = { ...config, model: "sonnet" };
    render(<AssistantPanel />);
    expect(model().value).toBe("");
    await waitFor(() => expect(model().value).toBe("sonnet"));
  });

  it("keeps what is being typed when the next answer lands", async () => {
    render(<AssistantPanel />);
    await waitFor(() => expect(model().value).toBe("opus"));
    fireEvent.change(model(), { target: { value: "haiku" } });

    config = { ...config, model: "sonnet" };
    const before = configReads();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(configReads()).toBe(before + 1));
    expect(model().value).toBe("haiku");
  });
});
