import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session as SessionInfo } from "../../shared/api";
import { resetPollCache } from "../src/api";
import Session from "../src/screens/Session";

/**
 * F-06. `usePoll` has told every screen since it was written which of its two
 * nulls it is holding, and this one never asked: a session id the pod does not
 * have sat on its skeletons for ever, which is exactly what a push tapped
 * after the session was deleted or swept from history lands on.
 */
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "no such session" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      ),
    ),
  );
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

describe("a session the pod does not have", () => {
  it("says so instead of loading for ever", async () => {
    render(
      <MemoryRouter initialEntries={["/s/vk-demo-9"]}>
        <Routes>
          <Route path="/s/:id" element={<Session />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("No such session")).toBeTruthy();
    expect(screen.getByText("vk-demo-9")).toBeTruthy();
  });
});

/**
 * F-07. `kill()` and `deleteSession()` had no catch: a DELETE that never
 * reached the pod navigated back to the project all the same, and the session
 * was still running when the list painted.
 */
describe("a delete the pod refuses", () => {
  const session = {
    id: "vk-demo-1",
    project: "demo",
    agent: "claude",
    title: "fix the parser",
    createdAt: new Date().toISOString(),
    endedAt: null,
    status: "done",
    report: null,
    outcome: "done",
    work: null,
    usage: null,
    measured: true,
    lastActivityAt: null,
    review: { verdict: null, note: null, at: null },
    unattended: null,
  } as unknown as SessionInfo;

  it("stays on the screen and says why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        Promise.resolve(
          init?.method === "DELETE"
            ? new Response(JSON.stringify({ error: "tmux is not answering" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              })
            : new Response(
                JSON.stringify(
                  url.startsWith("/api/sessions/vk-demo-1")
                    ? session
                    : url.endsWith("/git")
                      ? { branch: "main", files: [] }
                      : url.endsWith("/tree")
                        ? { nodes: [], truncated: false }
                        : [],
                ),
                { headers: { "content-type": "application/json" } },
              ),
        ),
      ),
    );
    render(
      <MemoryRouter initialEntries={["/s/vk-demo-1"]}>
        <Routes>
          <Route path="/s/:id" element={<Session />} />
          <Route path="/p/:name" element={<p>the project screen</p>} />
        </Routes>
      </MemoryRouter>,
    );

    // Two controls carry this label: the desktop row's and the phone's, and
    // jsdom draws both.
    fireEvent.click((await screen.findAllByLabelText("session actions"))[0]);
    fireEvent.click(await screen.findByRole("button", { name: "delete session" }));
    fireEvent.click(await screen.findByRole("button", { name: "delete" }));

    expect((await screen.findByRole("alert")).textContent).toContain("tmux is not answering");
    expect(screen.queryByText("the project screen")).toBeNull();
  });
});
