import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

/**
 * The one path a browser has to prove: the built app boots, routes, talks to
 * its own API, and can show what a run changed.
 *
 * Everything else in this repo is tested without a browser, which cannot catch
 * a bundle that fails to load, a route that renders nothing, or a component
 * that throws on real data — and this app is edited by unattended agents whose
 * only signal is the test suite. This is that signal.
 *
 * Deliberately no tmux and no agent: the session it drives is seeded as
 * finished metadata, so the test asserts the app rather than the CLIs. A live
 * terminal needs a real authenticated agent, which is a pod matter (see
 * BACKLOG).
 */
const ROOT = path.resolve(import.meta.dirname, "..");

let app: FastifyInstance;
let browser: Browser;
let page: Page;
let base: string;
let reposDir: string;
let sessionsDir: string;
/** Anything the browser logged as an error, or any request that failed. */
const problems: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

beforeAll(async () => {
  const dist = path.join(ROOT, "frontend", "dist");
  if (!fs.existsSync(path.join(dist, "index.html"))) {
    throw new Error("frontend/dist is missing — run `make e2e`, which builds it first");
  }

  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-repos-"));
  sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-sess-"));
  const repo = path.join(reposDir, "demo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "--initial-branch=main", ".");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "readme.md"), "start\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "first");
  const start = git(repo, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(repo, "readme.md"), "start\nand what the run added\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "the run's own commit");
  const end = git(repo, "rev-parse", "HEAD");

  fs.writeFileSync(
    path.join(sessionsDir, "vk-demo-1.json"),
    JSON.stringify({
      id: "vk-demo-1",
      project: "demo",
      agent: "claude",
      title: "overnight tidy",
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      endedAt: new Date().toISOString(),
      startCommit: start,
      endCommit: end,
      work: { commits: 1, files: 1, dirty: 0, unpushed: 1, branch: "main" },
    }),
  );

  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  process.env.SCHEDULES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-sched-"));
  process.env.STATIC_DIR = dist;
  const { buildApp } = await import("../backend/src/app.js");
  app = await buildApp({ logger: false });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (typeof addr === "string" || !addr) throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;

  browser = await chromium.launch({
    // The container runs as root without user namespaces — the same reason
    // browser.ts passes these to the session's own chromium.
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  // A phone, because that is what this app is used from.
  page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`request: ${r.url()}`));
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  for (const dir of [reposDir, sessionsDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the app in a real browser", () => {
  it("serves the hub with the repos on the volume", async () => {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("demo").first().waitFor({ timeout: 15_000 });
  });

  it("opens a project and lists its sessions", async () => {
    await page.getByText("demo").first().click();
    await page.waitForURL("**/p/demo");
    await page.getByText("overnight tidy").first().waitFor({ timeout: 15_000 });
  });

  it("shows the inbox, with the run's evidence and the way into it", async () => {
    await page.goto(`${base}/runs`, { waitUntil: "networkidle" });
    await page.getByText("Inbox").first().waitFor({ timeout: 15_000 });
  });

  it("reads a finished run's changes and opens the diff behind them", async () => {
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    // The panel the deep link asks for, its commit, and its file.
    await page.getByText("the run's own commit").waitFor({ timeout: 15_000 });
    await page.getByText("readme.md").first().click();
    // The diff overlay: the line the run added, straight out of git.
    await page.getByText("+and what the run added").waitFor({ timeout: 15_000 });
  });

  it("did all of that without a console error or a failed request", () => {
    expect(problems).toEqual([]);
  });
});
