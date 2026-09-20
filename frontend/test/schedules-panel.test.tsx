import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import SchedulesPanel from "../src/components/SchedulesPanel";

/**
 * F-05 from the audit: the new-schedule form posted the project the select
 * happened to be showing only if somebody had touched the select. Left alone —
 * which is what adding a schedule to your only repo looks like — it posted an
 * empty project and the pod answered 400, with the right repo on screen the
 * whole time.
 */

let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  fetchMock = vi.fn((url: string) => {
    if (url.startsWith("/api/projects")) return Promise.resolve(json([{ name: "demo" }]));
    if (url.startsWith("/api/council")) {
      return Promise.resolve(json([{ id: "chair", name: "the assistant", chair: true }]));
    }
    if (url.startsWith("/api/settings")) return Promise.resolve(json({ schedulesPaused: false }));
    return Promise.resolve(json([]));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
});

const posted = () =>
  fetchMock.mock.calls
    .filter(([url, init]) => url === "/api/schedules" && init?.method === "POST")
    .map(([, init]) => JSON.parse(init.body as string));

describe("adding a schedule", () => {
  it("posts the repo the picker is showing, untouched", async () => {
    render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );
    // The picker has to have its repos before the form means anything.
    await screen.findByRole("option", { name: "demo" });

    fireEvent.change(screen.getByLabelText("schedule name"), { target: { value: "merge greens" } });
    fireEvent.change(screen.getByLabelText("prompt"), { target: { value: "merge what is green" } });
    fireEvent.click(screen.getByRole("button", { name: "add schedule" }));

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].project).toBe("demo");
    expect(posted()[0].kind).toBe("session");
  });

  it("posts the repo that was picked, when one was", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/projects")) {
        return Promise.resolve(json([{ name: "demo" }, { name: "other" }]));
      }
      if (url.startsWith("/api/council")) {
        return Promise.resolve(json([{ id: "chair", name: "the assistant", chair: true }]));
      }
      if (url.startsWith("/api/settings")) return Promise.resolve(json({ schedulesPaused: false }));
      return Promise.resolve(json([]));
    });
    render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "other" });

    fireEvent.change(screen.getByLabelText("who runs it"), { target: { value: "other" } });
    fireEvent.change(screen.getByLabelText("schedule name"), { target: { value: "nightly" } });
    fireEvent.change(screen.getByLabelText("prompt"), { target: { value: "tidy up" } });
    fireEvent.click(screen.getByRole("button", { name: "add schedule" }));

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0].project).toBe("other");
  });
});
