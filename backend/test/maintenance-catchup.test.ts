import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * R-02: daily housekeeping on a 24-hour interval counted from boot never
 * happens on a pod that is redeployed several times a day. It is how the
 * nightly backup came to have no archive for the two busiest days of a
 * fortnight, and measuring and retiring sessions would have gone the same way:
 * scheduled, and never once run.
 */
const backfillUsage = vi.fn<() => Promise<number>>();
const archiveOldSessions = vi.fn<() => Promise<number>>();

vi.mock("../src/sessions-store.js", () => ({
  backfillUsage: () => backfillUsage(),
  archiveOldSessions: () => archiveOldSessions(),
  reapFinishedSessions: async () => [],
}));
vi.mock("../src/assistant-retention.js", () => ({ pruneAssistant: async () => 0 }));
vi.mock("../src/browser.js", () => ({ closeBrowser: async () => {}, unwatchedBrowsers: () => [] }));
vi.mock("../src/exec.js", () => ({ exec: async () => ({ stdout: "", stderr: "" }) }));

process.env.REPOS_DIR ??= "/tmp";
process.env.SESSIONS_DIR ??= "/tmp";
process.env.STATIC_DIR ??= "";

const { startMaintenance } = await import("../src/maintenance.js");

const log = { info: vi.fn(), warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  backfillUsage.mockResolvedValue(0);
  archiveOldSessions.mockResolvedValue(0);
});

afterEach(() => vi.useRealTimers());

describe("the daily catch-up", () => {
  it("runs on the way up, without waiting a day for it", async () => {
    vi.useFakeTimers();
    startMaintenance(log);

    await vi.advanceTimersByTimeAsync(0);

    expect(backfillUsage).toHaveBeenCalledTimes(1);
    // After the measuring, so a session is never retired carrying a gap the
    // archive has no way to fill in later.
    expect(archiveOldSessions).toHaveBeenCalledTimes(1);
    expect(backfillUsage.mock.invocationCallOrder[0]).toBeLessThan(
      archiveOldSessions.mock.invocationCallOrder[0],
    );
  });

  it("retires nothing when the measuring throws", async () => {
    vi.useFakeTimers();
    backfillUsage.mockRejectedValue(new Error("the volume is having a moment"));
    startMaintenance(log);

    await vi.advanceTimersByTimeAsync(0);

    expect(archiveOldSessions).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });
});
