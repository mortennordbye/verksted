import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The job that writes what the reads used to write. What matters about its
 * timer is that it keeps going and never runs on top of itself: a pass costs a
 * `tmux ls` and a walk of the session directory, and on a slow volume those can
 * outlast the interval.
 */
const sweepSessions = vi.fn<() => Promise<string[]>>();
vi.mock("../src/sessions-store.js", () => ({ sweepSessions: () => sweepSessions() }));
const pollBench = vi.fn<() => Promise<number>>();
vi.mock("../src/pollers.js", () => ({ pollBench: () => pollBench() }));

const { startSweeper } = await import("../src/sweeper.js");

const log = { info: vi.fn(), warn: vi.fn() };

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("startSweeper", () => {
  it("sweeps at once, then on its interval", async () => {
    vi.useFakeTimers();
    sweepSessions.mockResolvedValue([]);
    const stop = startSweeper(log);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(sweepSessions).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sweepSessions).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it("starts no pass while one is still running", async () => {
    vi.useFakeTimers();
    let finish: (ended: string[]) => void = () => {};
    sweepSessions.mockReturnValue(
      new Promise<string[]>((resolve) => {
        finish = resolve;
      }),
    );
    const stop = startSweeper(log);
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(sweepSessions).toHaveBeenCalledTimes(1);

      finish([]);
      sweepSessions.mockResolvedValue([]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sweepSessions).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("keeps sweeping after a pass throws, and says what it ended", async () => {
    vi.useFakeTimers();
    sweepSessions.mockRejectedValueOnce(new Error("tmux is having a moment"));
    const stop = startSweeper(log);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(log.warn).toHaveBeenCalled();

      sweepSessions.mockResolvedValue(["vk-demo-1"]);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining("vk-demo-1"));
    } finally {
      stop();
    }
  });

  /**
   * R-33: the feed was filed by the GET that read it, so opening the inbox
   * was what made the inbox correct. The sweeper files it now, after the
   * sessions so an end stamped this tick is filed this tick, and a failed
   * session sweep does not hold the feed back.
   */
  it("files the bench after the sessions, even when the session sweep failed", async () => {
    vi.useFakeTimers();
    sweepSessions.mockResolvedValueOnce([]);
    pollBench.mockResolvedValue(0);
    const stop = startSweeper(log);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(pollBench).toHaveBeenCalledTimes(1);
      expect(sweepSessions.mock.invocationCallOrder[0]).toBeLessThan(
        pollBench.mock.invocationCallOrder[0],
      );

      sweepSessions.mockRejectedValueOnce(new Error("tmux is having a moment"));
      await vi.advanceTimersByTimeAsync(5_000);
      expect(pollBench).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it("stops when it is told to", async () => {
    vi.useFakeTimers();
    sweepSessions.mockResolvedValue([]);
    const stop = startSweeper(log);
    await vi.advanceTimersByTimeAsync(0);
    stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sweepSessions).toHaveBeenCalledTimes(1);
  });
});
