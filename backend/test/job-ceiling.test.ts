import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BusyError } from "../src/serial.js";

/**
 * R-13, for the assistant's own jobs: a turn refused by a full queue never
 * started, so the slot of the day's ceiling reserved for it goes back.
 */
describe("an assistant job whose turn never starts", () => {
  it("hands back the slot of the ceiling it reserved", async () => {
    process.env.ASSISTANT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-asst-"));
    process.env.MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-mem-"));
    const refund = vi.fn();
    vi.doMock("../src/unattended-budget.js", () => ({
      unattendedBlocked: async () => null,
      refundCeiling: refund,
    }));
    vi.doMock("../src/assistant.js", () => ({
      saidOn: async () => [
        { role: "user", text: "remind me about the ferry", at: new Date().toISOString() },
      ],
      runUnattended: async () => {
        throw new BusyError("3 messages are already waiting");
      },
    }));
    const { runJournal } = await import("../src/assistant-jobs.js");
    const journal = await import("../src/journal-store.js");
    const log = { info: () => {}, warn: () => {}, error: () => {} };

    await expect(runJournal(log as never, journal.today())).rejects.toThrow(BusyError);
    expect(refund).toHaveBeenCalledWith(1);
  });
});
