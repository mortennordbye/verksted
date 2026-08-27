import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * Killing and deleting a session from the session screen.
 *
 * Both go through two overlays in a row — the actions sheet closes and the
 * confirm opens in the same tick — and both are guarded by a confirm that has
 * to survive that handover. When it does not, the action silently does nothing:
 * no error, no dialog, the session still there. Only a browser can catch it,
 * because the mechanism is the history entry each overlay pushes.
 */
const ROOT = path.resolve(import.meta.dirname, "..");

let app: FastifyInstance;
let browser: Browser;
let page: Page;
let base: string;
let reposDir: string;
let sessionsDir: string;

function seedSession(id: string) {
  fs.writeFileSync(
    path.join(sessionsDir, `${id}.json`),
    JSON.stringify({
      id,
      project: "demo",
      agent: "claude",
      title: `session ${id}`,
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date().toISOString(),
    }),
  );
}

beforeAll(async () => {
  const dist = path.join(ROOT, "frontend", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error("frontend/dist is missing — run `make e2e`, which builds it first");
  }
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-act-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-act-sess-"));
  const repo = path.join(reposDir, "demo");
  fs.mkdirSync(repo);
  execFileSync("git", ["-C", repo, "init", "-q", "--initial-branch=main", "."]);
  seedSession("vk-demo-1");

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-act-sched-"));
  process.env.STATIC_DIR = dist;
  const { buildApp } = await import("../backend/src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;

  browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  for (const dir of [reposDir, sessionsDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("deleting a session from its own screen", () => {
  it("asks first, and the question survives the sheet it was opened from", async () => {
    await page.goto(`${base}/s/vk-demo-1`, { waitUntil: "networkidle" });
    await page
      .getByRole("button", { name: /^session actions/ })
      .first()
      .click();
    await page.getByRole("button", { name: "delete session" }).click();

    // The confirm, still on screen a moment later rather than dismissed by the
    // history entry the actions sheet dropped on its way out.
    const confirm = page.getByRole("button", { name: "delete", exact: true });
    await confirm.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(300);
    await confirm.waitFor({ timeout: 1_000 });
  });

  it("removes the session, and leaves the screen it was on", async () => {
    await page.getByRole("button", { name: "delete", exact: true }).click();
    await page.waitForURL("**/p/demo", { timeout: 10_000 });
    expect(fs.existsSync(path.join(sessionsDir, "vk-demo-1.json"))).toBe(false);
  });

  // The other half of the same mechanism, and the reason it exists: Back is
  // what closes an overlay on a phone, and it must not leave the screen with
  // the session's terminal on it instead.
  it("still closes a sheet on Back, without leaving the session", async () => {
    seedSession("vk-demo-2");
    await page.goto(`${base}/s/vk-demo-2`, { waitUntil: "networkidle" });
    const actions = page.getByRole("button", { name: /^session actions/ }).first();
    await actions.click();
    await page.getByRole("button", { name: "delete session" }).waitFor({ timeout: 5_000 });

    await page.goBack();
    await page
      .getByRole("button", { name: "delete session" })
      .waitFor({ state: "hidden", timeout: 5_000 });
    expect(new URL(page.url()).pathname).toBe("/s/vk-demo-2");

    // And the entry it dropped is gone with it: one more Back leaves for good.
    await page.goBack();
    await page.waitForURL("**/p/demo", { timeout: 5_000 });
  });
});
