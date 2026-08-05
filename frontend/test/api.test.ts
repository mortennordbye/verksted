import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, OfflineError, api, usePoll } from "../src/api";
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
