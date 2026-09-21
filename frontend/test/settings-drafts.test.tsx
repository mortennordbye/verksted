import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Settings as SettingsInfo } from "../../shared/api";
import { resetPollCache } from "../src/api";
import Settings from "../src/screens/Settings";

/**
 * F-08. The environment fields were emptied when the save came back as well as
 * when it went through, and what is typed into them is a pasted API key or
 * token — the worst thing in the app to have to go and find a second time.
 */
const settings: SettingsInfo = {
  server: {},
  vars: [{ key: "GH_TOKEN", source: "unset", fingerprint: null, copyable: false }],
  schedulesPaused: false,
  blockedOwners: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
let refuse: boolean;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  refuse = true;
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return Promise.resolve(refuse ? json({ error: "the volume is read-only" }, 500) : json({}));
    }
    if (url.startsWith("/api/settings")) return Promise.resolve(json(settings));
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const draw = () =>
  render(
    <MemoryRouter initialEntries={["/settings?tab=agents"]}>
      <Settings />
    </MemoryRouter>,
  );

describe("a setting the pod would not store", () => {
  it("keeps what was typed", async () => {
    draw();
    const box = await screen.findByPlaceholderText("enter value…");
    fireEvent.change(box, { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    expect(await screen.findByText("the volume is read-only")).toBeTruthy();
    expect((box as HTMLInputElement).value).toBe("ghp_secret");
  });

  it("empties the field once it is stored", async () => {
    refuse = false;
    draw();
    const box = await screen.findByPlaceholderText("enter value…");
    fireEvent.change(box, { target: { value: "ghp_secret" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));

    await waitFor(() => expect((box as HTMLInputElement).value).toBe(""));
  });
});
