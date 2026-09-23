import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, OfflineError, api, resetPollCache, savePollCache, usePoll } from "../src/api";
import { useOnline } from "../src/connection";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // Explicit because testing-library only auto-cleans when vitest runs with
  // globals enabled. Without it every hook from an earlier test stays mounted,
  // keeps its interval, and answers the visibilitychange event below too.
  cleanup();
  resetPollCache();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("api", () => {
  it("returns the parsed body on success", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    await expect(api("/api/health")).resolves.toEqual({ ok: true });
  });

  it("throws ApiError carrying the status and the server's message", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await expect(api("/api/x")).rejects.toMatchObject({ status: 404, message: "not found" });
    await expect(api("/api/x")).rejects.toBeInstanceOf(ApiError);
  });

  // The distinction the connection banner is built on: a 500 means the backend
  // answered, a thrown fetch means nothing did.
  it("throws OfflineError when the request never gets an answer", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(api("/api/health")).rejects.toBeInstanceOf(OfflineError);
  });

  it("sends an abort signal so a dead tunnel cannot hang the request", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api("/api/health");
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps caller headers instead of replacing them", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api("/api/x", {
      method: "PUT",
      body: "raw",
      headers: { "content-type": "application/octet-stream", "if-match": "abc" },
    });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "content-type": "application/octet-stream",
      "if-match": "abc",
    });
  });

  it("still defaults to json for a body with no content-type", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api("/api/x", { method: "POST", body: "{}" });
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
      "content-type": "application/json",
    });
  });
});

describe("usePoll", () => {
  it("reports loading until the first answer arrives", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const { result } = renderHook(() => usePoll<unknown[]>("/api/projects"));
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
  });

  // data === null used to mean loading, empty and failed all at once, which is
  // why the hub flashed "no projects" on every open.
  it("tells an empty result apart from a pending one", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    const { result } = renderHook(() => usePoll<unknown[]>("/api/projects"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual([]);
    expect(result.current.notFound).toBe(false);
  });

  it("flags a 404 as notFound rather than a generic error", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    const { result } = renderHook(() => usePoll("/api/projects/ghost/sessions"));
    await waitFor(() => expect(result.current.notFound).toBe(true));
  });

  it("does not flag a 500 as notFound", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    const { result } = renderHook(() => usePoll("/api/projects"));
    await waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.notFound).toBe(false);
  });

  it("keeps the last good data when a later poll fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ name: "demo" }]));
    const { result } = renderHook(() => usePoll<{ name: string }[]>("/api/projects"));
    await waitFor(() => expect(result.current.data).toEqual([{ name: "demo" }]));

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => {
      result.current.refresh();
    });
    await waitFor(() => expect(result.current.error).toBe("can't reach the pod"));
    expect(result.current.data).toEqual([{ name: "demo" }]);
  });

  // Navigating back to a screen used to show its skeletons again every time.
  it("paints a path it has answered before at once, and refetches behind it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
    const first = renderHook(() => usePoll<{ v: number }>("/api/facts"));
    await waitFor(() => expect(first.result.current.data).toEqual({ v: 1 }));
    first.unmount();

    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 2 }));
    const { result } = renderHook(() => usePoll<{ v: number }>("/api/facts"));
    expect(result.current.data).toEqual({ v: 1 });
    expect(result.current.loading).toBe(false);
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
  });

  // A panel that adopted the first answer into state kept last visit's review
  // marks after a reload, and never looked at the server's newer ones.
  it("says whether its data is this visit's answer or a remembered one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
    const first = renderHook(() => usePoll("/api/facts"));
    await waitFor(() => expect(first.result.current.fresh).toBe(true));
    first.unmount();

    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 2 }));
    const { result } = renderHook(() => usePoll("/api/facts"));
    expect(result.current.data).toEqual({ v: 1 });
    expect(result.current.fresh).toBe(false);
    await waitFor(() => expect(result.current.fresh).toBe(true));
    expect(result.current.data).toEqual({ v: 2 });
  });

  // The installed app opened from the home screen used to start from skeletons.
  it("paints what the last launch saw, on the same build", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
    const first = renderHook(() => usePoll("/api/facts"));
    await waitFor(() => expect(first.result.current.data).toEqual({ v: 1 }));
    first.unmount();
    savePollCache();

    vi.resetModules();
    const relaunched = await import("../src/api");
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => relaunched.usePoll("/api/facts"));
    expect(result.current.data).toEqual({ v: 1 });
    expect(result.current.loading).toBe(false);
  });

  it("ignores what an older build stored", async () => {
    localStorage.setItem(
      "vk.poll-cache",
      JSON.stringify({ build: "an older build", entries: [["/api/facts", { v: 1 }]] }),
    );
    vi.resetModules();
    const relaunched = await import("../src/api");
    fetchMock.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => relaunched.usePoll("/api/facts"));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("forgets a path once it answers 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: 1 }));
    const first = renderHook(() => usePoll("/api/facts"));
    await waitFor(() => expect(first.result.current.data).toEqual({ v: 1 }));
    fetchMock.mockResolvedValue(jsonResponse({ error: "not found" }, 404));
    await act(async () => {
      first.result.current.refresh();
    });
    await waitFor(() => expect(first.result.current.notFound).toBe(true));
    first.unmount();

    const { result } = renderHook(() => usePoll("/api/facts"));
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  /**
   * F-16. Every poll answer used to be parsed, stored and applied whether or
   * not it said anything new — and most of them do not. What this pins is the
   * visible half: the same object comes back, so nothing downstream of it
   * re-renders on the tick.
   */
  it("does not even parse a poll answer that changed nothing", async () => {
    // mockImplementation, not mockResolvedValue: a Response body can be read
    // once, and every call here reads one.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ v: 1 })));
    const { result } = renderHook(() => usePoll<{ v: number }>("/api/facts"));
    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));
    const first = result.current.data;

    const parse = vi.spyOn(JSON, "parse");
    act(() => result.current.refresh());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The body was read and fingerprinted; nothing else was done with it.
    expect(parse).not.toHaveBeenCalled();
    expect(result.current.data).toBe(first);

    // And an answer that does say something new still lands.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ v: 2 })));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data).toEqual({ v: 2 }));
    expect(parse).toHaveBeenCalled();
    parse.mockRestore();
  });

  /**
   * The same, with two hooks on one path — three screens do exactly this with
   * /api/feed. The second must still end up holding the answer: the first one
   * having stored it is not the same as this one showing it.
   */
  it("gives a second hook on the same path the answer the first stored", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([{ id: "a" }])));
    const first = renderHook(() => usePoll<{ id: string }[]>("/api/feed"));
    await waitFor(() => expect(first.result.current.data).toHaveLength(1));

    const second = renderHook(() => usePoll<{ id: string }[]>("/api/feed"));
    await waitFor(() => expect(second.result.current.data).toHaveLength(1));
    // One object between them, so neither re-renders when the other refetches.
    expect(second.result.current.data).toBe(first.result.current.data);
  });

  /**
   * F-15. The tab bar, the inbox and Today all poll /api/feed, at 60, 15 and 30
   * seconds. Three timers meant three requests scattered across the minute for
   * an answer that is one answer.
   */
  it("asks once per tick however many hooks are on the path", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([{ id: "a" }])));
    const tabs = renderHook(() => usePoll("/api/feed", 4000));
    await vi.waitFor(() => expect(tabs.result.current.data).toHaveLength(1));

    // Mounted at its own moment, which is the thing: the tab bar is up long
    // before the inbox is opened, so two intervals started half a second apart
    // never fell on the same instant and neither could stand in for the other.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const inbox = renderHook(() => usePoll("/api/feed", 1000));
    await vi.waitFor(() => expect(inbox.result.current.data).toHaveLength(1));
    const mounted = fetchMock.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    // Four ticks of the fast one, with the slow one riding along on the fourth
    // — not four plus one of its own. Both are still up to date.
    expect(fetchMock.mock.calls.length).toBe(mounted + 4);
    expect(inbox.result.current.data).toHaveLength(1);
    expect(tabs.result.current.fresh).toBe(true);
  });

  /**
   * The other half of that. A refresh a screen asks for itself is the one after
   * a POST, and an answer the pod composed before the POST is the wrong answer
   * — so that one never rides along with a poll already in flight.
   */
  it("does not answer a screen's own refresh from a request that predates it", async () => {
    let release: ((body: unknown) => void) | undefined;
    fetchMock.mockImplementationOnce(
      () => new Promise((resolve) => (release = (b) => resolve(jsonResponse(b)))),
    );
    const { result } = renderHook(() => usePoll<{ v: number }[]>("/api/feed"));
    await waitFor(() => expect(release).toBeTruthy());

    // The POST landed; this is the read after it, with the first still open.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse([{ v: 2 }])));
    act(() => result.current.refresh());
    release!([{ v: 1 }]);

    await waitFor(() => expect(result.current.data).toEqual([{ v: 2 }]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  /**
   * F-14. A file tree is most of a megabyte and is re-read on arrival anyway;
   * the stored cache was serialising it, and a repo search, and a pane capture,
   * on the main thread every couple of seconds.
   */
  it("leaves the heavy, one-off answers out of the stored cache", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ nodes: [] })));
    const tree = renderHook(() => usePoll("/api/projects/demo/tree"));
    await waitFor(() => expect(tree.result.current.data).toEqual({ nodes: [] }));
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const facts = renderHook(() => usePoll("/api/facts"));
    await waitFor(() => expect(facts.result.current.data).toEqual({ ok: true }));

    savePollCache();
    const stored = localStorage.getItem("vk.poll-cache") ?? "";
    expect(stored).toContain("/api/facts");
    expect(stored).not.toContain("/tree");
  });

  /**
   * F-29. A path that answers 500 was asked again at its full rate for as long
   * as the screen stayed open — at the hub's, five hundred requests an hour,
   * all of them the same answer, all of them work for a pod already unhappy.
   */
  it("backs off while a path keeps failing, and recovers on an answer", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ error: "boom" }, 500)));
    const { result } = renderHook(() => usePoll("/api/facts", 1000));
    await vi.waitFor(() => expect(result.current.error).toBe("boom"));
    expect(result.current.failures).toBe(1);

    // The second poll is a tick away, not an interval away.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(result.current.failures).toBe(2));

    // And an answer puts it back on its own interval.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    await vi.waitFor(() => expect(result.current.failures).toBe(0));
    const settled = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(fetchMock.mock.calls.length).toBe(settled + 1);
  });

  // A screen that switches what it polls, like the session screen moving to
  // the next session, must not show one path's answer as the other's.
  it("starts a new path over from what that path last said", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ v: "b" }));
    const seen = renderHook(() => usePoll("/api/b"));
    await waitFor(() => expect(seen.result.current.fresh).toBe(true));
    seen.unmount();

    fetchMock.mockResolvedValueOnce(jsonResponse({ v: "a" }));
    const { result, rerender } = renderHook(({ path }) => usePoll(path), {
      initialProps: { path: "/api/a" },
    });
    await waitFor(() => expect(result.current.fresh).toBe(true));

    fetchMock.mockReturnValue(new Promise(() => {}));
    rerender({ path: "/api/b" });
    expect(result.current.data).toEqual({ v: "b" });
    expect(result.current.fresh).toBe(false);
    expect(result.current.loading).toBe(false);

    rerender({ path: "/api/c" });
    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("drops an answer for the path it has moved off", async () => {
    let answerA!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answerA = resolve)));
    const { result, rerender } = renderHook(({ path }) => usePoll(path), {
      initialProps: { path: "/api/a" },
    });

    fetchMock.mockReturnValue(new Promise(() => {}));
    rerender({ path: "/api/b" });
    await act(async () => {
      answerA(jsonResponse({ v: "a" }));
    });
    expect(result.current.data).toBeNull();
    expect(result.current.fresh).toBe(false);
  });

  it("does not fetch at all while the path is null", async () => {
    renderHook(() => usePoll(null));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Returning to a pocketed phone otherwise shows a full interval of stale data.
  it("refreshes as soon as the tab becomes visible", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderHook(() => usePoll("/api/projects"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe("connection reporting", () => {
  it("goes offline only after repeated transport failures, and recovers on any answer", async () => {
    // The connection store is module state, so an earlier test's failures carry
    // over. One success puts the counter back to zero.
    fetchMock.mockResolvedValue(jsonResponse({}));
    await api("/api/health");

    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => {
      await api("/api/health").catch(() => {});
    });
    // One blip on a phone radio is not an outage.
    expect(result.current).toBe(true);

    await act(async () => {
      await api("/api/health").catch(() => {});
    });
    expect(result.current).toBe(false);

    // Even a 500 proves the backend is reachable.
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, 500));
    await act(async () => {
      await api("/api/health").catch(() => {});
    });
    expect(result.current).toBe(true);
  });
});
