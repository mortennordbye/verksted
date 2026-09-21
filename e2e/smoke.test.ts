import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AxeBuilder } from "@axe-core/playwright";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { useTempDataDirs } from "./data-dirs.js";

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
let feedDir: string;
let dataDir: string;
/** Anything the browser logged as an error, or any request that failed. */
const problems: string[] = [];

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

/**
 * Until the screen has stopped drawing placeholders: the layout checks below
 * measure what is there, and a skeleton is not what is there. A fixed pause
 * was the wait, and on a cold CI runner it was sometimes too short (O-28).
 * Bounded, and not a failure on its own: a panel whose data never comes in
 * this fixture keeps its skeleton, and the check that follows says what it
 * finds either way.
 */
async function settled(on: Page): Promise<void> {
  await on
    .waitForFunction('!document.querySelector(".animate-skeleton-in")', null, { timeout: 10_000 })
    .catch(() => undefined);
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

  // One note filed by a session, so the inbox renders a `vk feedback` item in a
  // real browser rather than only in the route's unit test.
  feedDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-feed-"));
  fs.writeFileSync(
    path.join(feedDir, "bench_feedback_e2e.json"),
    JSON.stringify({
      id: "bench:feedback:e2e",
      source: "bench",
      at: new Date().toISOString(),
      title: "the bench is missing something: the file tree cannot rename a file",
      detail: "the file tree cannot rename a file\nfiled by claude in demo",
      urgency: "new",
      state: "new",
      until: null,
      link: "/s/vk-demo-1",
      loop: null,
      did: null,
      triaged: false,
      version: "filed",
      pushed: false,
    }),
  );

  process.env.FEED_DIR = feedDir;
  process.env.REPOS_DIR = reposDir;
  process.env.SESSIONS_DIR = sessionsDir;
  dataDir = useTempDataDirs("vk-e2e-data-");
  const schedulesDir = fs.mkdtempSync(path.join(os.tmpdir(), "vk-e2e-sched-"));
  process.env.SCHEDULES_DIR = schedulesDir;

  // A schedule whose last run signed off at length. The report is free text of
  // any length and it is the one server string that reaches a chip, so it is
  // what the no-sideways-scroll test below is actually aimed at.
  //
  // It signs off with `attention`, because that is the case Today used to draw
  // twice: once as the brief, in full, and once as a row that needs you with
  // the same words truncated. The row is the brief, so there is no row.
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
            "attention: three idle sessions, none stuck, one still holding uncommitted work, " +
            "two pull requests waiting on review and a nightly render that finished clean",
        },
      ],
    }),
  );

  // A stage schedule whose run failed the same way it always does — the one
  // row on Today that is meant to be waved off.
  fs.writeFileSync(path.join(sessionsDir, "vk-demo-2.report"), "failed: no sign-off\n");
  fs.writeFileSync(
    path.join(schedulesDir, "sch-2b3c4d5e.json"),
    JSON.stringify({
      id: "sch-2b3c4d5e",
      name: "scout",
      kind: "session",
      project: "demo",
      stage: "scout",
      cron: "0 3 * * *",
      jitterMinutes: 0,
      prompt: "",
      skipWhenIdle: false,
      member: "",
      convenes: false,
      enabled: true,
      createdAt: new Date().toISOString(),
      runs: [{ at: new Date().toISOString(), sessionId: "vk-demo-2", error: null }],
    }),
  );
  // A weekly stage whose one run failed four days ago. Its session ended with
  // it; there is nothing to open and nothing to do, so it is not a thing that
  // needs you today however loud its verdict was.
  fs.writeFileSync(path.join(sessionsDir, "vk-demo-3.report"), "failed: nothing was pushed\n");
  fs.writeFileSync(
    path.join(schedulesDir, "sch-3c4d5e6f.json"),
    JSON.stringify({
      id: "sch-3c4d5e6f",
      name: "weekly sweep",
      kind: "session",
      project: "demo",
      stage: "scout",
      cron: "0 22 * * 0",
      jitterMinutes: 0,
      prompt: "",
      skipWhenIdle: false,
      member: "",
      convenes: false,
      enabled: true,
      createdAt: new Date(Date.now() - 9 * 86_400_000).toISOString(),
      runs: [
        {
          at: new Date(Date.now() - 4 * 86_400_000).toISOString(),
          sessionId: "vk-demo-3",
          error: null,
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
  for (const dir of [reposDir, sessionsDir, feedDir, dataDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("the app in a real browser", () => {
  it("opens on today, with the brief in full and not also as a row", async () => {
    await page.goto(base, { waitUntil: "networkidle" });
    // The failed scout, and only it: the briefing signed off with `attention`
    // and is the card below, not a second thing to do.
    await page.getByText("1 thing needs you").waitFor({ timeout: 15_000 });
    await page.getByText("scout: no sign-off").waitFor({ timeout: 15_000 });
    await page.getByText("three idle sessions").waitFor({ timeout: 15_000 });
    // Four days old, and so not one of today's. Visible matches only: the
    // desktop rails are in the DOM on a phone, hidden by CSS, and the run is
    // still listed there — which is exactly where it belongs.
    expect(await page.getByText("weekly sweep").locator("visible=true").count()).toBe(0);
  });

  it("waves off a verdict, and the row goes", async () => {
    await page.goto(base, { waitUntil: "networkidle" });
    await page.getByText("scout: no sign-off").waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "dismiss" }).click();
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
    // What a session filed about the bench itself, in the one list.
    // Twice on the row, as the title and as the note itself; either will do.
    await page.getByText("the file tree cannot rename a file").first().waitFor({ timeout: 15_000 });
  });

  it("walks the inbox from the keyboard, and a key's action can be undone", async () => {
    await page.goto(`${base}/runs`, { waitUntil: "networkidle" });
    const row = page.locator('[id="bench:feedback:e2e"]');
    await row.waitFor({ timeout: 15_000 });

    // Walked to rather than assumed first: the seeded runs are on the list too,
    // and which of them sorts above the note is not what this is testing.
    for (let i = 0; i < 10 && (await row.getAttribute("aria-current")) !== "true"; i++) {
      await page.keyboard.press("j");
      await page.locator('main [aria-current="true"]').first().waitFor({ timeout: 15_000 });
    }
    expect(await row.getAttribute("aria-current")).toBe("true");

    await page.keyboard.press("e");
    await page.getByText("marked done").waitFor({ timeout: 15_000 });
    // Put back, so the rest of the suite still finds the note on the list.
    await page.getByRole("button", { name: "undo" }).click();
    await page.getByText("marked done").waitFor({ state: "detached", timeout: 15_000 });
  });

  it("reads a finished run's changes and opens the diff behind them", async () => {
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    // The panel the deep link asks for, its commit, and its file.
    await page.getByText("the run's own commit").waitFor({ timeout: 15_000 });
    await page.getByText("readme.md").first().click();
    // The diff overlay: the line the run added, straight out of git.
    await page.getByText("+and what the run added").waitFor({ timeout: 15_000 });
  });

  it("edits a file from the tree and writes it back to the repo", async () => {
    // ?side=changes is the one deep link into the side pane; the files tab is
    // a tap from there, which is the way a phone reaches the tree at all.
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "files", exact: true }).click();
    await page.getByText("readme.md").first().click();

    const viewer = page.getByRole("dialog", { name: "readme.md" });
    await viewer.getByRole("button", { name: "edit" }).click();
    await viewer
      .getByRole("textbox", { name: "readme.md (editing)" })
      .fill("start\nand what the run added\nand a line typed in the app\n");
    await viewer.getByRole("button", { name: "save" }).click();

    // The point of the whole thing: the working tree the agent shares.
    await expect
      .poll(() => fs.readFileSync(path.join(reposDir, "demo", "readme.md"), "utf8"), {
        timeout: 15_000,
      })
      .toContain("and a line typed in the app");
    // Back to reading, with what was saved on the screen.
    await viewer.getByRole("button", { name: "edit" }).waitFor({ timeout: 15_000 });
    // The viewer's own header is a phone control like any other: its ✕ is the
    // way out of a full-screen overlay, and it was an 18px glyph.
    expect(await smallButtons()).toEqual([]);
  });

  /**
   * F-04: the ✕, Escape and Back all asked before throwing away an unsaved
   * edit, and a tap on the backdrop — the easiest of the four to hit by
   * accident on a phone — dropped the file outright.
   */
  it("asks before a tap beside the file viewer throws away an edit", async () => {
    await page.goto(`${base}/s/vk-demo-1?side=changes`, { waitUntil: "networkidle" });
    await page.getByRole("radio", { name: "files", exact: true }).click();
    await page.getByText("readme.md").first().click();

    const viewer = page.getByRole("dialog", { name: "readme.md" });
    await viewer.getByRole("button", { name: "edit" }).click();
    await viewer.getByRole("textbox", { name: "readme.md (editing)" }).fill("typed, not saved\n");

    // The backdrop: the corner of the screen the dialog does not cover.
    await page.mouse.click(8, 8);

    // The confirm has one button, the one that goes through with it; every
    // other way out means no. Escape here is "no", and the edit is still there.
    const ask = page.getByRole("dialog", { name: "Discard the changes to this file?" });
    await ask.waitFor({ timeout: 15_000 });
    // Focus inside it is what says it is listening: a key pressed in the frame
    // between its paint and its effects still reaches the viewer under it.
    await expect
      .poll(
        () => ask.evaluate((el: { matches(s: string): boolean }) => el.matches(":focus-within")),
        { timeout: 15_000 },
      )
      .toBe(true);
    await page.keyboard.press("Escape");

    await expect
      .poll(() => viewer.getByRole("textbox", { name: "readme.md (editing)" }).inputValue(), {
        timeout: 15_000,
      })
      .toContain("typed, not saved");
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

  /**
   * What the bar carries, on both screens this app is used from.
   *
   * The rule is one rule: on a wide screen every screen carries the four as
   * words; on a phone the four doors carry them as a bottom bar and no back
   * arrow, because every other door is one tap away, and anything you drilled
   * into carries the arrow and its trail instead. It used to be decided screen by screen,
   * and had drifted — the inbox showed a trail and lost the words, the thread
   * had a back arrow and no bottom bar at all.
   */
  const DOORS = ["/", "/bench", "/runs", "/ai"];
  const DRILLED = ["/settings", "/docs", "/p/demo"];

  /** What the bar and the two navs are doing, as the browser has them. */
  async function bar(on: Page) {
    return on.evaluate(() => {
      const { document, getComputedStyle, innerWidth, location } = globalThis as unknown as {
        document: {
          querySelector(s: string): { innerText: string } | null;
          querySelectorAll(s: string): Iterable<object>;
        };
        getComputedStyle(el: object): { display: string };
        innerWidth: number;
        location: { pathname: string };
      };
      const navs = [...document.querySelectorAll('nav[aria-label="screens"]')];
      const header = document.querySelector("header");
      return {
        path: location.pathname,
        width: innerWidth,
        // The one place the app names itself, and the way home from anywhere.
        home: !!document.querySelector('a[aria-label="verksted — home"]'),
        header: !!header && getComputedStyle(header).display !== "none",
        crumb: header?.innerText.replace(/\n/g, " ") ?? "",
        back: !!document.querySelector('button[aria-label="back"]'),
        inbox: !!document.querySelector('a[href="/runs"]'),
        settings: !!document.querySelector('a[href="/settings"]'),
        words: navs.length > 0 && getComputedStyle(navs[0]).display !== "none",
        bottom: navs.length > 1 && getComputedStyle(navs[1]).display !== "none",
      };
    });
  }

  it("carries the same bar on every screen of a phone", async () => {
    for (const route of [...DOORS, ...DRILLED]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      const it = await bar(page);
      expect({ route, ...it }).toMatchObject({
        route,
        header: true,
        home: true,
        inbox: true,
        settings: true,
        // Words are for a wide screen; a phone gets the bar along the bottom.
        words: false,
        bottom: DOORS.includes(route),
        back: !DOORS.includes(route),
      });
    }
  });

  it("carries the same bar on every screen of a desktop, session included", async () => {
    const desk = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    desk.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
    try {
      for (const route of [...DOORS, ...DRILLED, "/s/vk-demo-1"]) {
        await desk.goto(`${base}${route}`, { waitUntil: "networkidle" });
        const it = await bar(desk);
        expect({ route, ...it }).toMatchObject({
          route,
          header: true,
          home: true,
          inbox: true,
          settings: true,
          // Every screen, since #145: a wide bar is the same bar everywhere.
          words: true,
          // The bottom bar is the phone's half of the same nav, never both.
          bottom: false,
          back: !DOORS.includes(route),
        });
      }
    } finally {
      await desk.close();
    }
  });

  /**
   * The one screen without the real bar: a phone session hides it to give the
   * terminal back the 75px, and its own row does the bar's jobs instead — the
   * way back, what you are looking at, and a sheet holding home, the inbox and
   * settings.
   */
  it("gives a phone session the bar's jobs without the bar", async () => {
    await page.goto(`${base}/s/vk-demo-1`, { waitUntil: "networkidle" });
    const it = await bar(page);
    expect(it.header).toBe(false);
    expect(it.back).toBe(true);
    await page.getByRole("button", { name: /^session actions/ }).click();
    const sheet = page.getByRole("dialog", { name: "overnight tidy" });
    await sheet.getByRole("link", { name: "verksted — home" }).waitFor({ timeout: 15_000 });
    await sheet.getByRole("link", { name: /^inbox/ }).waitFor({ timeout: 15_000 });
    await sheet.getByRole("link", { name: "settings" }).waitFor({ timeout: 15_000 });
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
    for (const route of [
      "/",
      "/bench",
      "/settings",
      "/runs",
      "/ai",
      "/docs",
      "/p/demo",
      "/s/vk-demo-1",
    ]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await settled(page);
      const wide = await page.evaluate(() => {
        // This closure runs in the browser, but it is compiled by the backend's
        // tsconfig, whose lib is ES2022 with no DOM — deliberately, since the
        // rest of that project is a server. Hence the local shape rather than a
        // `dom` lib that would also let `document` typecheck in `backend/src`.
        interface Box {
          tagName: string;
          className: unknown;
          parentElement: Box | null;
          getBoundingClientRect(): { width: number; right: number };
        }
        const { document, getComputedStyle } = globalThis as unknown as {
          document: {
            documentElement: { clientWidth: number };
            querySelectorAll(selector: string): Iterable<Box>;
          };
          getComputedStyle(el: Box): { overflowX: string };
        };
        const limit = document.documentElement.clientWidth;
        // Inside a box that clips or scrolls sideways, overflow is that box's
        // business: a tab strip that scrolls, or a line cut off with an
        // ellipsis, does not make the page pan. The box is still checked as an
        // element of its own. The walk stops at body, whose backstop would
        // otherwise excuse everything.
        const clipped = (el: Box) => {
          for (let p = el.parentElement; p && p.tagName !== "BODY"; p = p.parentElement) {
            if (getComputedStyle(p).overflowX !== "visible") return true;
          }
          return false;
        };
        return [...document.querySelectorAll("body *")]
          .filter((el) => {
            const box = el.getBoundingClientRect();
            return box.width > 0 && box.right > limit + 1 && !clipped(el);
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
    await settled(page);
    expect(await smallButtons()).toEqual([]);
  });

  // The share and the thread, which had never been asked: both are reached
  // from the bottom bar and both are read on a phone before anywhere else.
  it("gives a thumb something to hit on the share and the thread", async () => {
    for (const route of ["/docs", "/ai"]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await settled(page);
      expect([route, await smallButtons()]).toEqual([route, []]);
    }
  });

  // The session screen's own row, because the ⋯ on it is the way to delete a
  // session and it was a bare 13px glyph 6px from the next control — a coin
  // toss for a thumb, between two things that were not what you meant. It now
  // also carries the back arrow, which is the only way up on that screen.
  it("gives a thumb something to hit on the session screen too", async () => {
    await page.goto(`${base}/s/vk-demo-1`, { waitUntil: "networkidle" });
    await settled(page);
    expect(await smallButtons()).toEqual([]);
  });

  // The routes the thumb check had never been run on. The project screen is
  // where a session is started and a branch is made; the inbox is where a run
  // is answered from a lock screen.
  it("gives a thumb something to hit on the project screen and the inbox", async () => {
    for (const route of ["/p/demo", "/runs"]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await settled(page);
      expect([route, await smallButtons()]).toEqual([route, []]);
      expect([route, await narrowGlyphButtons()]).toEqual([route, []]);
    }
  });

  /**
   * Width, for the controls whose label carries none.
   *
   * `tap` is deliberately height-only — see theme.css, forcing 44px of width
   * would turn the terminal's key bar into a much longer scroll — and `tap-sq`
   * is the one for icon-only buttons, where there is no text to make the box
   * wide. This asks the question that distinction exists to answer: a button
   * whose whole label is a glyph has to be reachable sideways too. The blocked
   * owner's ✕ was about eight pixels wide.
   */
  async function narrowGlyphButtons() {
    return await page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: {
          querySelectorAll(selector: string): Iterable<{
            textContent: string | null;
            className: unknown;
            getAttribute(name: string): string | null;
            getBoundingClientRect(): { width: number; height: number };
          }>;
        };
      };
      return [...document.querySelectorAll("button")]
        .filter((el) => {
          const classes = String(el.className).split(/\s+/);
          if (classes.includes("tap-sq") || classes.includes("tap-hit")) return false;
          const label = (el.textContent ?? "").trim();
          // A glyph, or nothing at all: an icon-only control either way.
          if (label.length > 2) return false;
          const box = el.getBoundingClientRect();
          return box.width > 0 && box.width < 44;
        })
        .map((el) => {
          const label = (el.textContent ?? "").trim();
          return label || el.getAttribute("aria-label") || "(unnamed)";
        });
    });
  }

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
    for (const route of ["/settings", "/ai", "/s/vk-demo-1", "/s/vk-demo-1?side=files"]) {
      await page.goto(`${base}${route}`, { waitUntil: "networkidle" });
      await settled(page);
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

  /**
   * S-02. This screen used to post its query string to the intake on mount:
   * a GET that performs a POST, so any page the person had open could put
   * twenty thousand characters in their inbox, attributed to them, for the
   * next triage turn to read. The tap is the fix, and only a browser can
   * show that nothing left the page before it.
   */
  it("shows what was shared and sends nothing until it is tapped", async () => {
    const filed = () => fs.readdirSync(feedDir).filter((n) => n.startsWith("intake_"));
    await page.goto(`${base}/share?title=Renewal&text=the+domain+renews+on+the+3rd`, {
      waitUntil: "networkidle",
    });

    await page.getByText("the domain renews on the 3rd").waitFor({ timeout: 15_000 });
    expect(filed()).toEqual([]);

    await page.getByRole("button", { name: "send to inbox" }).click();
    await page.waitForURL("**/runs");
    expect(filed()).toHaveLength(1);
  });

  // F-49: the side column is a desk's, and on a phone the sources were in it
  // and nowhere else.
  it("shows whether the sources are set up on a phone too", async () => {
    await page.goto(`${base}/today`, { waitUntil: "networkidle" });
    await expect
      .poll(() => page.getByText("Sources", { exact: true }).first().isVisible())
      .toBe(true);
  });

  /**
   * F-48: an accessibility pass per route, by axe-core, against WCAG A and AA.
   * The lint rules see one element at a time; this sees the page as drawn,
   * which is where contrast and a name that never made it into the DOM show.
   */
  it("passes axe on every screen", async () => {
    // Its own context, and legacy mode, which runs axe inside the page: the
    // default finishes in a second page it opens on the context, which a page
    // from browser.newPage() will not allow. The app has no cross-origin
    // frames for the default mode to reach anyway.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await context.newPage();
    const found: string[] = [];
    for (const route of [
      "/today",
      "/runs",
      "/bench",
      "/p/demo",
      "/s/vk-demo-1",
      "/docs",
      "/settings",
    ]) {
      await phone.goto(`${base}${route}`, { waitUntil: "networkidle" });
      const { violations } = await new AxeBuilder({ page: phone })
        .setLegacyMode()
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      for (const v of violations) {
        found.push(`${route} ${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      }
    }
    await context.close();
    expect(found).toEqual([]);
  }, 120_000);

  /**
   * F-48: the tunnel dropping, in a real browser. The unit tests fake a failed
   * fetch; this is the browser going offline under a screen that is open, the
   * banner saying so, and the screen coming back when it returns.
   */
  it("says when the pod cannot be reached, and stops saying it when it can", async () => {
    // Its own context: the failed requests this makes are the point, and the
    // shared page's listener would count them as problems.
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const phone = await context.newPage();
    await phone.goto(`${base}/bench`, { waitUntil: "networkidle" });
    // Going somewhere is what a person does next, and what asks the pod for
    // something the screen does not already have.
    await context.setOffline(true);
    await phone.getByRole("link", { name: "Inbox" }).first().click();
    await phone.getByText("can't reach the pod").first().waitFor({ timeout: 30_000 });
    await context.setOffline(false);
    await phone.getByRole("link", { name: "Bench" }).first().click();
    await expect
      .poll(() => phone.getByText("can't reach the pod").count(), { timeout: 30_000 })
      .toBe(0);
    await context.close();
  }, 90_000);

  it("did all of that without a console error or a failed request", () => {
    expect(problems).toEqual([]);
  });
});
