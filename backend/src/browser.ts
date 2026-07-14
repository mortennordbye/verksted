import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import type { BrowserServerMsg } from "../../shared/api.js";

// One headless Chromium process per session, exposing a plain CDP endpoint on
// 127.0.0.1:<port>. The backend streams it to the browser pane, and the agent
// inside the session connects to the same endpoint (VK_BROWSER_CDP) with
// playwright connectOverCDP — the pane shows whatever either of them does.

export const CDP_PORT_BASE = 9222;
export const CDP_PORT_MAX = CDP_PORT_BASE + 199;

/** Lowest free CDP port. Ports live in session metadata, so they follow the session. */
export function nextCdpPort(used: Set<number>): number {
  for (let p = CDP_PORT_BASE; p <= CDP_PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  throw new Error("no free CDP ports");
}

/** User-entered navigation targets: web only — file:// would read the pod filesystem. */
export function validNavUrl(url: string): string | null {
  if (url.length > 2000) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(url);
  // "localhost:8080/x" parses as scheme "localhost:" — treat host:port as schemeless.
  const hostPort = scheme && /^\d+(\/.*)?$/.test(scheme[2]!);
  const withScheme = scheme && !hostPort ? url : `http://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

type Listener = (msg: BrowserServerMsg) => void;

interface Entry {
  port: number;
  proc: ChildProcess;
  browser: Browser;
  current: Page;
  cdp: CDPSession | null;
  listeners: Set<Listener>;
  dataDir: string;
}

const entries = new Map<string, Entry>();
const launching = new Map<string, Promise<Entry>>();

function broadcast(entry: Entry, msg: BrowserServerMsg): void {
  for (const l of entry.listeners) l(msg);
}

/** Point the stream and input at a page (the newest one the agent or user opened). */
async function setCurrent(entry: Entry, page: Page): Promise<void> {
  const streaming = entry.cdp !== null;
  if (streaming) await stopStream(entry);
  entry.current = page;
  // Headless dialogs would otherwise block the page forever.
  page.on("dialog", (d) => void d.dismiss().catch(() => {}));
  page.on("framenavigated", (f) => {
    if (entry.current === page && f === page.mainFrame()) {
      broadcast(entry, { t: "url", url: f.url() });
    }
  });
  page.on("close", () => {
    if (entry.current !== page) return;
    const rest = entry.browser.contexts().flatMap((c) => c.pages());
    if (rest.length > 0) void setCurrent(entry, rest.at(-1)!);
  });
  broadcast(entry, { t: "url", url: page.url() });
  if (streaming) await startStream(entry);
}

async function startStream(entry: Entry): Promise<void> {
  const cdp = await entry.current.context().newCDPSession(entry.current);
  entry.cdp = cdp;
  cdp.on("Page.screencastFrame", (p) => {
    broadcast(entry, {
      t: "frame",
      data: p.data,
      w: p.metadata.deviceWidth,
      h: p.metadata.deviceHeight,
    });
    void cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth: 1920,
    maxHeight: 1920,
    everyNthFrame: 1,
  });
}

async function stopStream(entry: Entry): Promise<void> {
  const cdp = entry.cdp;
  entry.cdp = null;
  if (cdp) {
    await cdp.send("Page.stopScreencast").catch(() => {});
    await cdp.detach().catch(() => {});
  }
}

async function launch(sessionId: string, port: number): Promise<Entry> {
  const dataDir = `/tmp/vk-browser-${sessionId}`;
  const proc = spawn(
    chromium.executablePath(),
    [
      "--headless=new",
      // The container runs as root without user namespaces; the pod is
      // single-user behind the VPN.
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${dataDir}`,
      "--window-size=1280,800",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chromium did not start")), 15_000);
    let err = "";
    proc.stderr!.on("data", (chunk: Buffer) => {
      err += chunk.toString();
      if (err.includes("DevTools listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.on("exit", () => {
      clearTimeout(timer);
      reject(new Error(`chromium exited: ${err.slice(-500)}`));
    });
  });
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 10_000 });
  const ctx = browser.contexts()[0] ?? (await browser.newContext());
  const entry: Entry = {
    port,
    proc,
    browser,
    current: ctx.pages()[0] ?? (await ctx.newPage()),
    cdp: null,
    listeners: new Set(),
    dataDir,
  };
  // Follow pages the agent (or a target=_blank link) opens.
  ctx.on("page", (p) => void setCurrent(entry, p));
  proc.on("exit", () => {
    if (entries.get(sessionId) === entry) {
      entries.delete(sessionId);
      broadcast(entry, { t: "error", message: "browser exited" });
    }
  });
  await setCurrent(entry, entry.current);
  entries.set(sessionId, entry);
  return entry;
}

/** Launch (or reuse) the session's browser. Concurrent callers share one launch. */
export async function ensureBrowser(sessionId: string, port: number): Promise<Entry> {
  const existing = entries.get(sessionId);
  if (existing) return existing;
  let pending = launching.get(sessionId);
  if (!pending) {
    pending = launch(sessionId, port).finally(() => launching.delete(sessionId));
    launching.set(sessionId, pending);
  }
  return pending;
}

export async function addListener(entry: Entry, listener: Listener): Promise<void> {
  entry.listeners.add(listener);
  listener({ t: "init", url: entry.current.url(), cdpUrl: `http://127.0.0.1:${entry.port}` });
  if (entry.listeners.size === 1) await startStream(entry);
}

export async function removeListener(entry: Entry, listener: Listener): Promise<void> {
  entry.listeners.delete(listener);
  // The browser keeps running for the agent; only the stream stops.
  if (entry.listeners.size === 0) await stopStream(entry);
}

export async function closeBrowser(sessionId: string): Promise<void> {
  const entry = entries.get(sessionId) ?? (await launching.get(sessionId)?.catch(() => undefined));
  if (!entry) return;
  entries.delete(sessionId);
  await stopStream(entry);
  await entry.browser.close().catch(() => {});
  // Wait for chromium to die before removing its data dir, or the shutdown
  // recreates files under it.
  if (entry.proc.exitCode === null) {
    entry.proc.kill();
    await new Promise<void>((resolve) => {
      const hardKill = setTimeout(() => {
        entry.proc.kill("SIGKILL");
        resolve();
      }, 5_000);
      entry.proc.once("exit", () => {
        clearTimeout(hardKill);
        resolve();
      });
    });
  }
  await fs.rm(entry.dataDir, { recursive: true, force: true }).catch(() => {});
}

/** Best-effort teardown on backend shutdown so dev restarts don't orphan chromium. */
export function killAll(): void {
  for (const entry of entries.values()) entry.proc.kill();
  entries.clear();
}

export function browserCount(): number {
  return entries.size;
}

/** Browsers nobody is watching in the UI — reaper candidates (see maintenance.ts). */
export function unwatchedBrowsers(): { id: string; port: number }[] {
  return [...entries]
    .filter(([, e]) => e.listeners.size === 0)
    .map(([id, e]) => ({ id, port: e.port }));
}

export type { Entry as BrowserEntry };
