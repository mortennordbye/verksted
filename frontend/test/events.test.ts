import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../../shared/api";
import { usePoll } from "../src/api";
import { resetStream, streamHealthy, streamTopic, streamValue } from "../src/events";

/** Stands in for the browser's EventSource, which jsdom does not implement. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, ((e: unknown) => void)[]>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), cb]);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data?: unknown) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data: JSON.stringify(data) });
  }

  /** Raw payload, for what a stream carrying something else would do. */
  emitRaw(type: string, data: string) {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }
}

const latest = () => FakeEventSource.instances.at(-1)!;

const session = (id: string, status: Session["status"] = "running") => ({ id, status }) as Session;

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  FakeEventSource.instances = [];
  fetchMock = vi.fn().mockResolvedValue(jsonResponse([]));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource);
});

afterEach(() => {
  cleanup();
  resetStream();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("streamTopic", () => {
  it("knows the paths the stream answers", () => {
    expect(streamTopic("/api/sessions")).toBe("sessions");
    expect(streamTopic("/api/projects")).toBe("projects");
    // One session by id comes out of the same list.
    expect(streamTopic("/api/sessions/vk-demo-1")).toBe("sessions");
  });

  it("leaves anything deeper to its own request", () => {
    // Different questions that merely start the same way — the bug this guards
    // is a session's changes or chat being answered with the session list.
    expect(streamTopic("/api/sessions/vk-demo-1/changes")).toBe(null);
    expect(streamTopic("/api/sessions/vk-demo-1/chat")).toBe(null);
    expect(streamTopic("/api/projects/demo/sessions")).toBe(null);
    expect(streamTopic("/api/facts")).toBe(null);
  });
});

describe("streamValue", () => {
  it("says nothing until the stream has said something", () => {
    expect(streamValue("/api/sessions")).toBeUndefined();
  });

  it("answers a list and a single session from one snapshot", async () => {
    const { unmount } = renderHook(() => usePoll<Session[]>("/api/sessions"));
    await act(async () => {
      latest().emit("sessions", [session("vk-demo-1"), session("vk-demo-2", "waiting")]);
    });

    expect(streamValue<Session[]>("/api/sessions")!.value).toHaveLength(2);
    expect(streamValue<Session>("/api/sessions/vk-demo-2")!.value!.status).toBe("waiting");
    // Said, and there is no such session: a 404 by another name.
    expect(streamValue<Session>("/api/sessions/vk-ghost-9")!.value).toBe(null);
    unmount();
  });
});

describe("usePoll over the stream", () => {
  it("takes its data from the stream", async () => {
    const { result } = renderHook(() => usePoll<Session[]>("/api/sessions"));
    await act(async () => {
      latest().emit("sessions", [session("vk-demo-1")]);
    });

    expect(result.current.data).toEqual([session("vk-demo-1")]);
    expect(result.current.loading).toBe(false);
    expect(streamHealthy()).toBe(true);
  });

  it("resolves one session out of the list, and reports an absent one as missing", async () => {
    const { result } = renderHook(() => usePoll<Session>("/api/sessions/vk-ghost-9"));
    await act(async () => {
      latest().emit("sessions", [session("vk-demo-1")]);
    });

    expect(result.current.notFound).toBe(true);
  });

  it("stops polling a path the stream is serving", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => usePoll<Session[]>("/api/sessions", 5_000));
    // One fetch on mount, because the stream has not answered yet.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest().emit("sessions", [session("vk-demo-1")]);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    // Six intervals would have passed. The stream is healthy, so none of them
    // cost a request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual([session("vk-demo-1")]);
  });

  it("goes back to polling at the asked-for rate when the stream fails", async () => {
    vi.useFakeTimers();
    renderHook(() => usePoll<Session[]>("/api/sessions", 5_000));
    await act(async () => {
      latest().emit("sessions", [session("vk-demo-1")]);
    });
    expect(streamHealthy()).toBe(true);

    await act(async () => {
      latest().emit("error");
    });
    expect(streamHealthy()).toBe(false);

    const before = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    // Two intervals of five seconds, rather than the hour a dead stream would
    // otherwise leave the screen sitting on.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
  });

  it("gives up on a stream that connects and then says nothing", async () => {
    vi.useFakeTimers();
    renderHook(() => usePoll<Session[]>("/api/sessions", 5_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });

    expect(streamHealthy()).toBe(false);
  });

  it("leaves a path it does not serve polling as before", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    renderHook(() => usePoll("/api/facts", 5_000));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("ignores a message that is not this app's", async () => {
    // A captive portal or a proxy answering the stream with HTML must not count
    // as the stream working, or the screen would stop polling and sit there.
    const { result } = renderHook(() => usePoll<Session[]>("/api/sessions"));
    await act(async () => {
      latest().emitRaw("sessions", "<html>a proxy said hello</html>");
    });

    expect(streamHealthy()).toBe(false);
    // The ordinary fetch is still what answered.
    expect(result.current.data).toEqual([]);
  });

  it("opens one connection for the whole app, not one per screen", async () => {
    renderHook(() => usePoll<Session[]>("/api/sessions"));
    renderHook(() => usePoll("/api/projects"));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("drops the connection while the tab is in a pocket, and rebuilds it after", async () => {
    renderHook(() => usePoll<Session[]>("/api/sessions"));
    const first = latest();

    await act(async () => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(first.closed).toBe(true);

    await act(async () => {
      vi.spyOn(document, "hidden", "get").mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(latest().closed).toBe(false);
  });
});
