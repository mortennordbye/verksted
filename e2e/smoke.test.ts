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
  const schedulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-sched-"));
  process.env.SCHEDULES_DIR = schedulesDir;

  // A schedule whose last run signed off at length. The report is free text of
  // any length and it is the one server string that reaches a chip, so it is
  // what the no-sideways-scroll test below is actually aimed at.
  fs.writeFileSync(
    path.join(schedulesDir, "sch-1a2b3c4d.json"),
    JSON.stringify({
      // The id has to match the store's SCHEDULE_ID_RE, or the file is skipped
      // on read and the page shows "no schedules" instead.
      id: "sch-1a2b3c4d",
      name: "morning briefing",
      kind: "assistant",
      project: "",
      cron: "0 7 * * *",
      jitterMinutes: 0,
      prompt: "what needs me today?",
      skipWhenIdle: false,
      member: "",
      convenes: false,
      enabled: true,
      createdAt: new Date().toISOString(),
      runs: [
        {
          at: new Date().toISOString(),
          sessionId: null,
          reply:
            "ok: three idle sessions, none stuck, one still holding uncommitted work, " +
            "two pull requests waiting on review and a nightly render that finished clean",
        },
      ],
    }),
  );
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
  // A phone, because that is what this app is used from — and hasTouch, because
  // without it the pointer stays fine and every `@media (pointer: coarse)` rule
  // in theme.css is inert. That is most of what makes this app usable on a
  // phone: the 44px tap targets and the 16px fields that stop iOS zooming.
  page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
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
  it("opens on today, with nothing needing you", async () => {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("Nothing needs you.").waitFor({ timeout: 15_000 });
  });

  it("serves the bench with the repos on the volume", async () => {
    await page.goto(`${base}/bench`, { waitUntil: "networkidle" });
    await page.getByText("demo").first().waitFor({ timeout: 15_000 });
  });

  it("opens a project and lists its sessions", async () => {
    // By href rather than by text: the hub shows a project's name in its card
    // and again on any session card belonging to it, and only one of those is
    // the way into the project.
    await page.locator('a[href="/p/demo"]').first().click();
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

  it("reads the whole run in one scroll, and remembers what was read", async () => {
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /review all/ }).click();

    const review = page.getByRole("dialog", { name: "review vk-demo-1" });
    // The range's own patch, not a per-file request: the file's header and the
    // line the run added are both in the one answer.
    await review.getByText("readme.md").first().waitFor({ timeout: 15_000 });
    await review.getByText("+and what the run added").waitFor({ timeout: 15_000 });

    // click rather than check: the tick is controlled by the server's answer,
    // so it only moves once the round trip lands.
    await review.getByRole("checkbox").first().click();
    await review.getByText("1 of 1 read").waitFor({ timeout: 15_000 });
    await review.getByRole("button", { name: /approved/ }).click();

    // Reloading is the point: the marks live on the session, so a review begun
    // on a phone is still there on a laptop.
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    await page.getByText("✓ approved").waitFor({ timeout: 15_000 });
    await page.getByText("1 of 1 read").first().waitFor({ timeout: 15_000 });
  });

  it("gets home from a session by the wordmark, not only the back arrow", async () => {
    // The way to the hub used to be a 9px dot with no label, which is not a
    // thing anyone finds. The name is the link now, at a thumb-sized target —
    // one tap in rather than zero, since the phone session screen stopped
    // showing a top bar and the name moved into the ⋯ sheet with it.
    await page.goto(`${base}/s/vk-demo-1`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^session actions/ }).click();
    // Scoped to the dialog: the top bar is still in the DOM for a wide screen,
    // display:none, and getByLabel — unlike getByRole — matches it.
    await page
      .getByRole("dialog", { name: "overnight tidy" })
      .getByLabel("verksted — home")
      .click();
    await page.waitForURL((u) => u.pathname === "/");
    await page.getByText("Nothing needs you.").waitFor({ timeout: 15_000 });
  });

  // A phone is the main way in, and a single element that will not wrap is
  // enough to make a whole screen pannable — the symptom being black space
  // beside the layout, which points nowhere near the cause. Asserted per
  // element rather than on documentElement.scrollWidth, because `body` carries
  // an overflow-x backstop that would make the document-level check pass while
  // the element still overflowed.
  it("has nothing hanging off the side of a phone screen", async () => {
    const offenders: string[] = [];
    for (const route of ["/", "/bench", "/settings", "/runs", "/p/demo", "/s/vk-demo-1"]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(300);
      const wide = await page.evaluate(() => {
        // This closure runs in the browser, but it is compiled by the backend's
        // tsconfig, whose lib is ES2022 with no DOM — deliberately, since the
        // rest of that project is a server. Hence the local shape rather than a
        // `dom` lib that would also let `document` typecheck in `backend/src`.
        const { document } = globalThis as unknown as {
          document: {
            documentElement: { clientWidth: number };
            querySelectorAll(selector: string): Iterable<{
              tagName: string;
              className: unknown;
              getBoundingClientRect(): { width: number; right: number };
            }>;
          };
        };
        const limit = document.documentElement.clientWidth;
        return [...document.querySelectorAll("body *")]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.right > limit + 1;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 80)}`);
      });
      offenders.push(...wide.map((w) => `${route} ${w}`));
    }
    expect(offenders).toEqual([]);
  });

  // Settings is the page a thumb actually uses on a bus — pause a schedule, run
  // one now — and every control on it was about 30px until now, the back arrow
  // on every screen with it. Only the visible box is asserted here; `tap-hit`,
  // which reaches the finger without growing the box, is not covered by this.
  it("gives a thumb something to hit on every control on settings", async () => {
    await page.goto(`${base}/settings`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    expect(await smallButtons()).toEqual([]);
  });

  // The session screen's own row, because the ⋯ on it is the way to delete a
  // session and it was a bare 13px glyph 6px from the next control — a coin
  // toss for a thumb, between two things that were not what you meant. It now
  // also carries the back arrow, which is the only way up on that screen.
  it("gives a thumb something to hit on the session screen too", async () => {
    await page.goto(`${base}/s/vk-demo-1`, { waitUntil: "networkidle" });
    await page.waitForTimeout(500);
    expect(await smallButtons()).toEqual([]);
  });

  async function smallButtons() {
    return await page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: {
          querySelectorAll(selector: string): Iterable<{
            textContent: string | null;
            className: unknown;
            getBoundingClientRect(): { width: number; height: number };
          }>;
        };
      };
      return [...document.querySelectorAll("button")]
        .filter((el) => {
          // `tap-hit` answers this question with a 44px ::after rather than a
          // 44px box, which is the whole reason it exists — measuring the box
          // here would report every control that has already opted in. What
          // the overlay is actually doing is asserted below instead.
          if (String(el.className).split(/\s+/).includes("tap-hit")) return false;
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.height < 44;
        })
        .map((el) => (el.textContent ?? "").trim().slice(0, 30));
    });
  }

  // The other half of the exemption above: a `tap-hit` is only allowed to be
  // 28px because of its overlay, so something has to check the overlay is
  // there. It is the one thing that catches it silently doing nothing — an
  // ancestor that clips it, or the class landing on an element the rule's
  // `position: relative` cannot anchor.
  it("gives the tap-hit controls the 44px they are exempt on", async () => {
    for (const route of ["/settings", "/s/vk-demo-1"]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      const bad = await page.evaluate(() => {
        // Not destructured: `getComputedStyle` called off `globalThis` throws
        // an illegal invocation without its receiver.
        const g = globalThis as unknown as {
          document: { querySelectorAll(selector: string): Iterable<{ className: unknown }> };
          getComputedStyle(el: unknown, pseudo: string): { height: string };
        };
        return [...g.document.querySelectorAll(".tap-hit")]
          .filter((el) => g.getComputedStyle(el, "::after").height !== "44px")
          .map((el) => String(el.className).slice(0, 60));
      });
      expect(bad).toEqual([]);
    }
  });

  it("did all of that without a console error or a failed request", () => {
    expect(problems).toEqual([]);
  });
});
