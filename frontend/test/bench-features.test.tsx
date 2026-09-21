import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/api";
import { resetPollCache } from "../src/api";
import Hub from "../src/screens/Hub";
import Project from "../src/screens/Project";

/** F-49: the project's session list at a month's length, and an empty bench's first step. */
const at = (n: number) => new Date(Date.now() - n * 3_600_000).toISOString();
const session = (id: string, title: string, agent: string, status: string, hoursAgo: number) =>
  ({
    id,
    title,
    agent,
    status,
    project: "demo",
    createdAt: at(hoursAgo),
    endedAt: status === "done" ? at(hoursAgo - 1) : null,
    report: null,
    outcome: status === "done" ? "done" : "running",
  }) as unknown as Session;

const sessions = [
  session("vk-demo-5", "live one", "claude", "running", 1),
  session("vk-demo-4", "fix the parser", "codex", "done", 5),
  session("vk-demo-3", "tidy the docs", "claude", "done", 10),
  session("vk-demo-2", "bump deps", "claude", "done", 20),
  session("vk-demo-1", "first go", "codex", "done", 30),
];

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return Promise.resolve(json({}));
    if (url.includes("/sessions")) return Promise.resolve(json(sessions));
    if (url === "/api/settings") {
      return Promise.resolve(
        json({
          server: {},
          vars: [
            { key: "GH_TOKEN", source: "settings", fingerprint: "…a1" },
            { key: "CLAUDE_CODE_OAUTH_TOKEN", source: "unset", fingerprint: null },
          ],
          schedulesPaused: false,
          blockedOwners: [],
        }),
      );
    }
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", undefined);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const project = () =>
  render(
    <MemoryRouter initialEntries={["/p/demo"]}>
      <Routes>
        <Route path="/p/:name" element={<Project />} />
      </Routes>
    </MemoryRouter>,
  );

const titles = () =>
  screen
    .getAllByRole("link")
    .map((l) => l.textContent ?? "")
    .filter((t) => t.includes("vk-demo"));

describe("a project's sessions", () => {
  it("narrow to what is typed", async () => {
    project();
    fireEvent.change(await screen.findByRole("textbox", { name: "filter sessions" }), {
      target: { value: "codex" },
    });
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(titles().every((t) => t.includes("codex") || /parser|first go/.test(t))).toBe(true);
  });

  it("sort oldest first when asked", async () => {
    project();
    fireEvent.change(await screen.findByRole("combobox", { name: "sort sessions" }), {
      target: { value: "oldest" },
    });
    await waitFor(() => expect(titles()[1]).toContain("first go"));
  });

  it("delete a stack of finished ones behind one confirm", async () => {
    project();
    fireEvent.click(await screen.findByRole("button", { name: "select" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "pick tidy the docs" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "pick bump deps" }));
    // A live session is not on offer.
    expect(screen.queryByRole("checkbox", { name: "pick live one" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "delete 2" }));
    const ask = await screen.findByRole("dialog", { name: "Delete 2 finished sessions?" });
    fireEvent.click(within(ask).getByRole("button", { name: "delete 2" }));
    await waitFor(() => {
      const deleted = (fetchMock.mock.calls as [string, RequestInit?][])
        .filter(([, init]) => init?.method === "DELETE")
        .map(([url]) => url);
      expect(deleted.sort()).toEqual([
        "/api/sessions/vk-demo-2?purge=1",
        "/api/sessions/vk-demo-3?purge=1",
      ]);
    });
  });
});

describe("an empty bench", () => {
  it("says what the first clone needs, and which of it is set", async () => {
    // Only what the empty state reads; the rest of the bench's panels are
    // told there is nothing there, which they each handle.
    const answer = fetchMock.getMockImplementation() as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url === "/api/settings" || url === "/api/projects" || url === "/api/sessions"
        ? answer(url, init)
        : Promise.resolve(new Response("{}", { status: 404 })),
    );
    render(
      <MemoryRouter>
        <Hub />
      </MemoryRouter>,
    );
    const first = (await screen.findByText("No projects yet")).parentElement!;
    await waitFor(() =>
      expect(within(first).getByText(/GH_TOKEN/).parentElement!.textContent).toContain("set ·"),
    );
    expect(within(first).getByText("an agent's sign-in").parentElement!.textContent).toContain(
      "not set",
    );
    expect(within(first).getByRole("link", { name: "settings" }).getAttribute("href")).toBe(
      "/settings?tab=agents",
    );
  });
});
