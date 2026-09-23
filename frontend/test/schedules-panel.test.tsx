import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetPollCache } from "../src/api";
import SchedulesPanel from "../src/components/SchedulesPanel";

/**
 * The recurring-prompt panel, on the two counts where what is on screen and
 * what it would post came apart: F-05 below, and F-12 further down.
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

/**
 * F-12. The list paints from the answer the last visit left behind, and the
 * editor used to seed itself from whatever row was on screen when it opened.
 * Open one in that beat and the cron and the prompt in the boxes could be a day
 * old — and "save" PATCHes them back over everything that changed since.
 */
describe("editing a schedule the list has not refetched yet", () => {
  const schedule = (cron: string) => [
    {
      id: "s1",
      name: "nightly",
      kind: "session",
      project: "demo",
      cron,
      jitterMinutes: 0,
      prompt: "tidy up",
      enabled: true,
      convenes: false,
      skipWhenIdle: false,
      stage: null,
      lastRunAt: null,
      lastSessionId: null,
      lastError: null,
      lastReport: null,
      nextRunAt: null,
    },
  ];

  const answerWith = (schedules: unknown, hold?: Promise<void>) =>
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/schedules") && !url.includes("preview")) {
        if (hold) await hold;
        return json(schedules);
      }
      if (url.startsWith("/api/projects")) return json([{ name: "demo" }]);
      if (url.startsWith("/api/council")) {
        return json([{ id: "chair", name: "the assistant", chair: true }]);
      }
      if (url.startsWith("/api/settings")) return json({ schedulesPaused: false });
      return json([]);
    });

  it("waits for this visit's answer before filling the boxes", async () => {
    // A first visit, which is what leaves an answer in the cache. Both patterns
    // differ from the new-schedule form's default, which is the other field on
    // this screen with the same label.
    answerWith(schedule("15 9 * * 1"));
    const first = render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );
    await screen.findByText("15 9 * * 1");
    first.unmount();

    // The second, with the cron changed under it and the answer held back.
    let release!: () => void;
    answerWith(schedule("30 6 * * *"), new Promise<void>((r) => (release = r)));
    render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );
    // Painted from the cache, so the stale pattern is on screen and tappable.
    fireEvent.click(await screen.findByRole("button", { name: "edit" }));
    const crons = () =>
      screen.getAllByLabelText("cron pattern").map((i) => (i as HTMLInputElement).value);
    // Only the new-schedule form's field: the row's editor is still waiting.
    expect(crons()).toEqual(["0 8 * * 1-5"]);

    release();
    await waitFor(() => expect(crons()).toHaveLength(2));
    expect(crons()).toContain("30 6 * * *");
    expect(crons()).not.toContain("15 9 * * 1");
  });
});

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

describe("a schedule fired by a trigger", () => {
  it("posts the trigger, and may leave the cron empty once one is chosen", async () => {
    render(
      <MemoryRouter>
        <SchedulesPanel project="demo" />
      </MemoryRouter>,
    );
    await screen.findByText(/recurring prompts/i);

    fireEvent.change(screen.getByLabelText("schedule name"), { target: { value: "on review" } });
    fireEvent.change(screen.getByLabelText("prompt"), { target: { value: "review it" } });
    fireEvent.change(screen.getByLabelText("cron pattern"), { target: { value: "" } });
    const add = screen.getByRole("button", { name: "add schedule" });
    // Nothing would fire it.
    expect(add).toHaveProperty("disabled", true);

    fireEvent.change(screen.getByLabelText("trigger"), { target: { value: "review" } });
    expect(add).toHaveProperty("disabled", false);
    fireEvent.click(add);

    await waitFor(() => expect(posted()).toHaveLength(1));
    expect(posted()[0]).toMatchObject({ project: "demo", cron: "", trigger: "review" });
  });

  it("offers no trigger to an assistant schedule, which has no repo", async () => {
    render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );
    await screen.findByRole("option", { name: "demo" });
    expect(screen.getByLabelText("trigger")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("who runs it"), { target: { value: "member:" } });
    expect(screen.queryByLabelText("trigger")).toBeNull();
  });

  it("says in its row what fires it", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.startsWith("/api/projects/demo/schedules")) {
        return json([
          {
            id: "s1",
            name: "on review",
            kind: "session",
            project: "demo",
            cron: "",
            trigger: "review",
            jitterMinutes: 0,
            prompt: "review it",
            enabled: true,
            convenes: false,
            skipWhenIdle: false,
            stage: null,
            lastRunAt: null,
            lastSessionId: null,
            lastError: null,
            lastReport: null,
            nextRunAt: null,
          },
        ]);
      }
      if (url.startsWith("/api/settings")) return json({ schedulesPaused: false });
      return json([]);
    });
    render(
      <MemoryRouter>
        <SchedulesPanel project="demo" />
      </MemoryRouter>,
    );
    expect(await screen.findByText("when a PR wants my review")).toBeTruthy();
    // Not "paused": it has no next tick because it has no clock.
    expect(screen.getByText("on its trigger")).toBeTruthy();
  });
});

/**
 * A briefing or triage turn that wedges held the unattended queue for ten
 * minutes with nothing on screen saying so, and the chat's stop only reaches
 * the conversation on screen.
 */
describe("the unattended turn in flight", () => {
  it("is shown with a stop that ends it", async () => {
    let running: unknown = { label: "nightly digest", startedAt: new Date().toISOString() };
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/assistant/unattended/stop" && init?.method === "POST") {
        running = null;
        return json({ stopped: true });
      }
      if (url === "/api/assistant/unattended") return json({ running });
      if (url.startsWith("/api/settings")) return json({ schedulesPaused: false });
      return json([]);
    });
    render(
      <MemoryRouter>
        <SchedulesPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByText("nightly digest")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "stop" }));

    await waitFor(() => expect(screen.queryByText("nightly digest")).toBeNull());
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/assistant/unattended/stop" && init?.method === "POST",
      ),
    ).toBe(true);
  });

  it("is not on a project's own list", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/assistant/unattended"
        ? json({ running: { label: "triage", startedAt: new Date().toISOString() } })
        : json(url.startsWith("/api/settings") ? { schedulesPaused: false } : []),
    );
    render(
      <MemoryRouter>
        <SchedulesPanel project="demo" />
      </MemoryRouter>,
    );
    await screen.findByText(/recurring prompts/i);
    expect(screen.queryByText("triage")).toBeNull();
  });
});
