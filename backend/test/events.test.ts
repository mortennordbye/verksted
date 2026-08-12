import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The hub is about when it computes and what it forwards; both sources are
// stubbed so a test can decide what "changed" means.
const sessions = vi.fn<() => Promise<unknown>>();
const projects = vi.fn<() => Promise<unknown>>();

vi.mock("../src/sessions-store.js", () => ({ listSessions: () => sessions() }));
vi.mock("../src/projects-store.js", () => ({ listProjects: () => projects() }));

const { subscribe, clientCount, resetEvents, setEventLogger } = await import("../src/events.js");

/** Long enough for both intervals (sessions 3s, projects 10s) to have ticked. */
const BOTH_TICKS = 10_000;

let sent: [string, string][];

beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  sessions.mockReset().mockResolvedValue([{ id: "vk-demo-1", status: "running" }]);
  projects.mockReset().mockResolvedValue([{ name: "demo" }]);
  setEventLogger({ warn: () => {} });
});

afterEach(() => {
  resetEvents();
  vi.useRealTimers();
});

const record = (topic: string, json: string) => sent.push([topic, json]);
const topics = () => sent.map(([t]) => t);

describe("the event hub", () => {
  it("sends both answers to a client that has just attached", async () => {
    subscribe(record);
    await vi.advanceTimersByTimeAsync(0);

    expect(topics().sort()).toEqual(["projects", "sessions"]);
    expect(sent.find(([t]) => t === "sessions")![1]).toContain("vk-demo-1");
  });

  it("says nothing while the answer is the same", async () => {
    subscribe(record);
    await vi.advanceTimersByTimeAsync(BOTH_TICKS * 2);

    // The sources were asked repeatedly; the client heard once per topic.
    expect(sessions.mock.calls.length).toBeGreaterThan(1);
    expect(topics()).toEqual(["sessions", "projects"]);
  });

  it("sends again as soon as the answer differs", async () => {
    subscribe(record);
    await vi.advanceTimersByTimeAsync(0);
    sessions.mockResolvedValue([{ id: "vk-demo-1", status: "waiting" }]);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(topics().filter((t) => t === "sessions")).toHaveLength(2);
    expect(sent.at(-1)![1]).toContain("waiting");
  });

  it("computes once for every client attached, not once each", async () => {
    const other: [string, string][] = [];
    subscribe(record);
    subscribe((topic, json) => other.push([topic, json]));
    await vi.advanceTimersByTimeAsync(0);
    const asked = sessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);

    // One further tick, one further call — two clients did not double it.
    expect(sessions.mock.calls.length).toBe(asked + 1);
    // And both of them were told what it found.
    expect(topics()).toContain("sessions");
    expect(other.map(([t]) => t)).toContain("sessions");
  });

  it("stops working entirely once the last client goes", async () => {
    const detach = subscribe(record);
    await vi.advanceTimersByTimeAsync(0);
    detach();
    const asked = sessions.mock.calls.length;
    await vi.advanceTimersByTimeAsync(BOTH_TICKS * 2);

    expect(clientCount()).toBe(0);
    expect(sessions.mock.calls.length).toBe(asked);
  });

  it("detaches once however often it is called", async () => {
    const detach = subscribe(record);
    const other = subscribe(() => {});
    detach();
    detach();
    other();

    expect(clientCount()).toBe(0);
  });

  it("keeps going when a source throws, and says nothing about it", async () => {
    sessions.mockRejectedValue(new Error("tmux is gone"));
    subscribe(record);
    await vi.advanceTimersByTimeAsync(0);
    // Only the healthy topic reached the client; the failed one is not pushed
    // as an error into a status badge.
    expect(topics()).toEqual(["projects"]);

    sessions.mockResolvedValue([{ id: "vk-demo-2", status: "running" }]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(topics()).toContain("sessions");
  });

  it("hands a joining client what is already known, without recomputing", async () => {
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    const asked = sessions.mock.calls.length;

    subscribe(record);
    expect(topics().sort()).toEqual(["projects", "sessions"]);
    expect(sessions.mock.calls.length).toBe(asked);
  });

  it("does not hand a joining client a snapshot from before everyone left", async () => {
    const detach = subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    detach();

    subscribe(record);
    // Nothing arrives until the restarted watcher has an answer of its own.
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(topics().sort()).toEqual(["projects", "sessions"]);
  });
});
