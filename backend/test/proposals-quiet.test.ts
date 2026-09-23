import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * A card filed from a screen that shows it (the settings page's Gmail filters)
 * pushes nothing: the person is looking at it already. Any other still does.
 */
const announce = vi.fn(async () => {});
vi.mock("../src/notifier.js", async (orig) => ({
  ...(await orig<typeof import("../src/notifier.js")>()),
  announce: (...args: unknown[]) => announce(...(args as [])),
}));

let app: FastifyInstance;

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-quiet-"));
  process.env.FEED_DIR = path.join(dir, "feed");
  process.env.SETTINGS_FILE = path.join(dir, "settings.json");
  process.env.REPOS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-quiet-r-"));
  process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-quiet-s-"));
  process.env.PUSH_FILE = path.join(dir, "push.json");
  process.env.STATIC_DIR = "";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ logger: false });
});

afterAll(async () => {
  await app.close();
});

const action = {
  kind: "calendar_put",
  summary: "Dentist",
  start: "2026-10-01T10:00:00Z",
  end: "2026-10-01T11:00:00Z",
};

describe("filing a card", () => {
  it("pushes to the phone unless it was filed quietly", async () => {
    const loud = await app.inject({ method: "POST", url: "/api/proposals", payload: { action } });
    expect(loud.statusCode).toBe(201);
    expect(announce).toHaveBeenCalledTimes(1);

    const quiet = await app.inject({
      method: "POST",
      url: "/api/proposals",
      payload: { action, quiet: true },
    });
    expect(quiet.statusCode).toBe(201);
    expect(announce).toHaveBeenCalledTimes(1);
  });
});
