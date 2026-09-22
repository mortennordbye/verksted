import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A-27: the assistant's directory grows for good. What goes after a month is
 * what nobody asked to keep: unattended threads and uploads. The person's own
 * conversations stay, because they are what recall searches.
 */
let dir: string;
let pruneAssistant: typeof import("../src/assistant-retention.js").pruneAssistant;

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse("2026-09-22T12:00:00Z");

function put(rel: string, ageDays: number): string {
  const file = path.join(dir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "x");
  const at = new Date(NOW - ageDays * DAY);
  fs.utimesSync(file, at, at);
  return file;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-retention-"));
  process.env.ASSISTANT_DIR = dir;
  process.env.REPOS_DIR ??= "/tmp";
  process.env.SESSIONS_DIR ??= "/tmp";
  process.env.STATIC_DIR ??= "";
  ({ pruneAssistant } = await import("../src/assistant-retention.js"));
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("pruning the assistant's directory", () => {
  it("drops old unattended threads and uploads and keeps the person's own chats", async () => {
    const oldRun = put("unattended/11111111-1111-1111-1111-111111111111.jsonl", 31);
    const newRun = put("unattended/22222222-2222-2222-2222-222222222222.jsonl", 29);
    const oldShot = put("uploads/old.png", 45);
    const newShot = put("uploads/new.png", 1);
    const oldChat = put("33333333-3333-3333-3333-333333333333.jsonl", 400);
    const log = { info: vi.fn() };

    expect(await pruneAssistant(log, NOW)).toBe(2);

    expect(fs.existsSync(oldRun)).toBe(false);
    expect(fs.existsSync(oldShot)).toBe(false);
    expect(fs.existsSync(newRun)).toBe(true);
    expect(fs.existsSync(newShot)).toBe(true);
    expect(fs.existsSync(oldChat)).toBe(true);
    expect(log.info).toHaveBeenCalledOnce();
  });

  it("leaves a directory or a link alone, whatever its age", async () => {
    const sub = path.join(dir, "uploads", "nested");
    fs.mkdirSync(sub, { recursive: true });
    const target = put("elsewhere.txt", 90);
    const link = path.join(dir, "uploads", "link.png");
    fs.symlinkSync(target, link);
    const at = new Date(NOW - 90 * DAY);
    fs.utimesSync(sub, at, at);
    fs.lutimesSync(link, at, at);

    await pruneAssistant({ info: vi.fn() }, NOW);

    expect(fs.existsSync(sub)).toBe(true);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(true);
  });

  it("is quiet when there is nothing there", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vk-retention-empty-"));
    process.env.ASSISTANT_DIR = empty;
    vi.resetModules();
    const fresh = await import("../src/assistant-retention.js");
    const log = { info: vi.fn() };
    expect(await fresh.pruneAssistant(log, NOW)).toBe(0);
    expect(log.info).not.toHaveBeenCalled();
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
