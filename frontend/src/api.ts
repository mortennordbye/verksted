import { useCallback, useEffect, useRef, useState } from "react";
import { reportReachable, reportUnreachable } from "./connection";
import { streamHealthy, streamTopic, streamValue, subscribeStream } from "./events";

/** The backend answered, and said no. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * What a failure to reach the pod at all says, as opposed to a pod that
 * answered and said no. The connection banner is already on screen for this
 * one, so nothing else needs to repeat it.
 */
export const OFFLINE_MESSAGE = "can't reach the pod";

/** Nothing answered: the pod is gone, or the tunnel is down. */
export class OfflineError extends Error {
  constructor() {
    super(OFFLINE_MESSAGE);
  }
}

// Over a dropped WireGuard tunnel a fetch hangs until the browser gives up
// minutes later, and until then the screen sits on stale data looking healthy.
const TIMEOUT_MS = 15_000;

export async function api<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<T> {
  return (await answer<T>(path, init)).parse();
}

/**
 * The same request, with the body as it arrived and the parse left undone.
 *
 * `usePoll` wants the text first: comparing it against the last answer is how a
 * poll that changed nothing — which is most of them — costs neither a parse,
 * nor a render, nor a write to the stored cache.
 */
type Answer<T> = { text: string; parse: () => T };

async function answer<T>(
  path: string,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Answer<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(init?.timeoutMs ?? TIMEOUT_MS),
      headers: {
        // Merged, not replaced: callers pass their own content-type for raw
        // uploads and If-Match when saving.
        ...(init?.body && !(init.headers as Record<string, string>)?.["content-type"]
          ? { "content-type": "application/json" }
          : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    reportUnreachable();
    throw new OfflineError();
  }
  reportReachable();
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? `HTTP ${res.status}`);
  }
  const text = await res.text();
  return { text, parse: () => JSON.parse(text) as T };
}

/**
 * The GETs `usePoll` currently has in flight, by path.
 *
 * Three hooks want `/api/feed` — the tab bar, the inbox and Today — and the
 * ticker below fires them on the same instant. Sharing the request makes that
 * one request and one parse: by the time the second hook's `.then` runs, the
 * first has stored the body and its fingerprint, so the second reads the cache.
 *
 * Only the timed polls share. A `refresh()` a screen asks for itself is usually
 * the one after a POST, and joining a request that was issued before it would
 * answer with what the pod thought a moment ago.
 */
const inFlight = new Map<string, Promise<Answer<unknown>>>();

function shared<T>(path: string): Promise<Answer<T>> {
  const running = inFlight.get(path);
  if (running) return running as Promise<Answer<T>>;
  const started = answer<T>(path);
  inFlight.set(path, started);
  const done = () => {
    if (inFlight.get(path) === started) inFlight.delete(path);
  };
  // Both branches, and both handled here: the caller has its own catch.
  started.then(done, done);
  return started;
}

/**
 * One timer per path, rather than one per hook.
 *
 * The tab bar, the inbox and Today all poll `/api/feed`, at 60, 15 and 30
 * seconds. Three independent intervals meant three requests scattered across
 * the minute for what is one answer. They share a timer now: it runs at the
 * shortest rate anyone asked for, and each subscriber still fires only on its
 * own rate — so the slow ones land on an instant the fast one is already asking
 * at, and `shared` above turns that into a single request.
 */
type Sub = { every: number; last: number; fire: () => void };
type Ticker = { id: ReturnType<typeof setInterval>; every: number; subs: Set<Sub> };
const tickers = new Map<string, Ticker>();

function tick(path: string): void {
  const t = tickers.get(path);
  if (!t || document.hidden) return;
  const now = Date.now();
  for (const sub of t.subs) {
    // Half a tick of slack, because a timer fires a hair late and a 30 s
    // subscriber on a 15 s ticker would otherwise miss its instant by a
    // millisecond and wait another whole tick for the next one.
    if (now - sub.last < sub.every - t.every / 2) continue;
    sub.last = now;
    sub.fire();
  }
}

function retime(path: string): void {
  const t = tickers.get(path);
  if (!t) return;
  let every = Infinity;
  for (const sub of t.subs) every = Math.min(every, sub.every);
  if (every === t.every) return;
  clearInterval(t.id);
  t.every = every;
  t.id = setInterval(() => tick(path), every);
}

function subscribeTick(path: string, every: number, fire: () => void): () => void {
  const sub: Sub = { every, last: Date.now(), fire };
  let t = tickers.get(path);
  if (!t) {
    t = { id: setInterval(() => tick(path), every), every, subs: new Set() };
    tickers.set(path, t);
  }
  t.subs.add(sub);
  retime(path);
  return () => {
    const current = tickers.get(path);
    if (!current) return;
    current.subs.delete(sub);
    if (current.subs.size > 0) return retime(path);
    clearInterval(current.id);
    tickers.delete(path);
  };
}

/** How often a streamed path is still fetched anyway. Cover for a stream that
 *  connects, reports itself healthy and then quietly stops delivering. */
const BACKSTOP_MS = 60_000;

/** How far a failing path is allowed to back off to. */
const BACKOFF_MAX_MS = 60_000;

/**
 * The last answer for each path. A screen opened again paints from it at once
 * and refetches behind it, instead of showing its skeletons on every visit.
 * Bounded because file trees and PR details are keyed per session and per PR.
 */
const cache = new Map<string, unknown>();
const CACHE_MAX = 200;

/**
 * A fingerprint of the last body seen for a path.
 *
 * Kept beside the cache rather than the body itself: one file tree is most of a
 * megabyte, and all this has to answer is "is this the same answer again". It
 * almost always is — a session list polled every three seconds changes when
 * something happens, not on the tick.
 */
const stamps = new Map<string, string>();

function stamp(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${h >>> 0}`;
}

function remember(path: string, value: unknown, text?: string): void {
  cache.delete(path);
  cache.set(path, value);
  if (text === undefined) stamps.delete(path);
  else stamps.set(path, stamp(text));
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value!;
    cache.delete(oldest);
    stamps.delete(oldest);
  }
  scheduleSave();
}

function forget(path: string): void {
  stamps.delete(path);
  if (cache.delete(path)) scheduleSave();
}

/**
 * The cache outlives the page too, so the installed app opened from the home
 * screen paints the screens it last saw instead of starting from skeletons.
 *
 * Keyed by build: a response shape from before a deploy is not one the new code
 * promises to read. Written a beat after answers settle and when the page is
 * put away rather than on every poll, and capped, since one file tree can be
 * most of a megabyte.
 */
const STORE_KEY = "vk.poll-cache";
const STORE_MAX_CHARS = 1_000_000;
const SAVE_DELAY_MS = 2_000;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** The entry script's hashed filename, which every build changes. */
function buildId(): string {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? "none";
}

function loadStored(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(STORE_KEY) ?? "null") as {
      build: string;
      entries: [string, unknown][];
    } | null;
    if (stored?.build !== buildId()) return;
    // Stored newest first; inserted oldest first, so eviction keeps its order.
    for (const [path, value] of [...stored.entries].reverse()) cache.set(path, value);
  } catch {
    // Private mode, blocked storage or a corrupt entry: start empty, as before.
  }
}

/**
 * What is worth keeping between launches.
 *
 * A file tree is most of a megabyte and is re-read on arrival anyway; a repo
 * search and a pane capture are answers to a question nobody asks twice. All
 * three were being serialised into localStorage with everything else, which is
 * a megabyte of `JSON.stringify` on the main thread for data no screen paints
 * from.
 */
function worthStoring(path: string): boolean {
  return !/\/(tree|search|capture|raw|file)(\?|$)/.test(path);
}

/** Write the cache out now. Exported as the test seam for a relaunch. */
export function savePollCache(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  const parts: string[] = [];
  let size = 0;
  for (const entry of [...cache].reverse()) {
    if (!worthStoring(entry[0])) continue;
    const json = JSON.stringify(entry);
    if (size + json.length > STORE_MAX_CHARS) continue;
    parts.push(json);
    size += json.length;
  }
  try {
    localStorage.setItem(
      STORE_KEY,
      `{"build":${JSON.stringify(buildId())},"entries":[${parts.join(",")}]}`,
    );
  } catch {
    // Over quota or blocked: the in-memory cache still serves this visit.
  }
}

function scheduleSave(): void {
  saveTimer ??= setTimeout(savePollCache, SAVE_DELAY_MS);
}

if (typeof document !== "undefined") {
  loadStored();
  // A phone put back in a pocket may be killed before the timer fires, and an
  // installed app is closed without either event on some platforms — pagehide
  // is the one iOS is reliable about.
  const flush = () => {
    if (saveTimer) savePollCache();
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flush();
  });
  addEventListener("pagehide", flush);
}

/** Test seam: module state, and a test file is one page. */
export function resetPollCache(): void {
  clearTimeout(saveTimer);
  saveTimer = undefined;
  cache.clear();
  stamps.clear();
  inFlight.clear();
  for (const ticker of tickers.values()) clearInterval(ticker.id);
  tickers.clear();
  try {
    localStorage.removeItem(STORE_KEY);
  } catch {
    // nothing was stored
  }
}

/**
 * Poll a GET endpoint. Pass null to pause (e.g. while a param is unknown).
 *
 * `loading` exists because `data === null` used to mean three different things
 * at once — still loading, genuinely empty, and failed — so the hub flashed "no
 * projects" on every load and an unknown session id sat on "…" forever.
 *
 * Some paths are pushed rather than polled (see events.ts): those take their
 * data from the stream, drop to a slow backstop interval, and fall straight
 * back to polling at the requested rate the moment the stream stops looking
 * healthy. Call sites do not choose — a path is streamed or it is not.
 */
export function usePoll<T>(path: string | null, ms = 5000) {
  const [data, setData] = useState<T | null>(() =>
    path !== null && cache.has(path) ? (cache.get(path) as T) : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(path !== null && !cache.has(path));
  const [notFound, setNotFound] = useState(false);
  /**
   * Whether `data` is an answer from this visit rather than one remembered from
   * an earlier one. Anything that copies data into local state once, like a
   * form's draft, must wait for it: otherwise it adopts last visit's answer and
   * never looks at the new one.
   */
  const [fresh, setFresh] = useState(false);
  const streamed = path !== null && streamTopic(path) !== null;
  const [streamOk, setStreamOk] = useState(streamHealthy);
  /**
   * Which answer is the current one. Bumped by every request and by every push,
   * so a reply that arrives after something newer is dropped rather than
   * applied — over a tunnel a slow fetch really can land after the push that
   * superseded it, and the screen would then go backwards.
   */
  const generation = useRef(0);
  /**
   * The fingerprint of the answer this hook is holding, or null when it holds
   * something whose body it never saw — the cache from an earlier visit, or a
   * push off the stream. Per hook, because two hooks on one path have their own
   * `data` and the cache they share cannot say what either of them is showing.
   */
  const showing = useRef<string | null>(null);
  /**
   * How many polls in a row have failed, which is how far the timer backs off.
   *
   * A path that answers 500 was asked again at its full rate for as long as the
   * screen was open — five hundred requests an hour at the hub's, all of them
   * the same answer, all of them work for a pod that is already unhappy.
   */
  const [failures, setFailures] = useState(0);

  /**
   * Ask the path again. `share` says whether this one may ride along with a
   * request another hook on the same path already has in flight — true for the
   * timed polls, false for a `refresh()` a screen asked for, which is usually
   * the one right after a POST and must not be answered from before it.
   */
  const run = useCallback(
    (share: boolean) => {
      if (!path) return;
      const mine = ++generation.current;
      const current = () => mine === generation.current;
      (share ? shared<T>(path) : answer<T>(path))
        .then(({ text, parse }) => {
          if (!current()) return;
          const mark = stamp(text);
          // An answer that says the same as the one this hook is already
          // showing is most of them. Applying it anyway re-parsed the body,
          // re-rendered every subscriber and rewrote the stored cache on every
          // tick — Today holds nine polls and re-reads its brief through
          // react-markdown on each, and one file tree is most of a megabyte.
          if (showing.current === mark) {
            setFresh(true);
            setError(null);
            setNotFound(false);
            setFailures(0);
            return;
          }
          // Another hook on the same path may have parsed and stored this very
          // body a moment ago. Then the work is done and only this hook has to
          // catch up — and it catches up to that same object, so the two stay
          // identical and neither re-renders the other's subscribers.
          const known = stamps.get(path) === mark;
          const value = known ? (cache.get(path) as T) : parse();
          if (!known) remember(path, value, text);
          showing.current = mark;
          setData(value);
          setFresh(true);
          setError(null);
          setNotFound(false);
          setFailures(0);
        })
        .catch((e: Error) => {
          if (!current()) return;
          setError(e.message);
          setFailures((n) => n + 1);
          // A 404 is an answer, not a failure to reach anything: it means this
          // project or session does not exist, and the screen should say so
          // rather than poll a dead path forever.
          if (e instanceof ApiError && e.status === 404) {
            forget(path);
            setNotFound(true);
          }
        })
        .finally(() => current() && setLoading(false));
    },
    [path],
  );

  /** What a screen calls after it changed something. Never shared. */
  const refresh = useCallback(() => run(false), [run]);

  // What the path is worth: reset on a change of path (to what it last said, if
  // anything), then take the first answer from whichever of the two can give
  // it. Deliberately not keyed on stream health — a stream dropping must not
  // blank the screen.
  useEffect(() => {
    const cached = path !== null && cache.has(path);
    setData(cached ? (cache.get(path) as T) : null);
    // What the cache holds is what its stamp describes, so an unchanged first
    // answer is free too. Null when nothing was cached, or when the cached
    // value came from the stream rather than from a body.
    showing.current = cached ? (stamps.get(path) ?? null) : null;
    setNotFound(false);
    setFresh(false);
    setFailures(0);
    setLoading(path !== null && !cached);
    if (path === null) return;

    const fromStream = (): boolean => {
      const hit = streamValue<T>(path);
      if (!hit) return false;
      if (hit.value === null) forget(path);
      else remember(path, hit.value);
      // Newer than anything in flight, by definition: the server sent it.
      generation.current++;
      showing.current = null;
      setData(hit.value);
      setFresh(true);
      setNotFound(hit.value === null);
      setError(null);
      setLoading(false);
      return true;
    };

    // Navigating back to a screen the stream already covers paints from what it
    // last sent, with no request at all.
    if (!streamed || !fromStream()) run(true);
    if (!streamed) return;

    return subscribeStream(() => {
      setStreamOk(streamHealthy());
      fromStream();
    });
  }, [run, path, streamed]);

  // The timer, at the requested rate or as a slow backstop behind the stream —
  // and backed off while the path is failing, doubling to a minute.
  useEffect(() => {
    if (path === null) return;
    const base = streamed && streamOk ? Math.max(ms, BACKSTOP_MS) : ms;
    const every = failures === 0 ? base : Math.min(BACKOFF_MAX_MS, base * 2 ** failures);
    const untick = subscribeTick(path, every, () => run(true));
    // Coming back to a backgrounded tab or a pocketed phone otherwise shows up
    // to a full interval of stale data before the next tick. Shared, so a
    // screen holding several polls of one path wakes up owing one request.
    const onVisible = () => {
      if (!document.hidden) run(true);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      untick();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [run, ms, path, streamed, streamOk, failures]);

  return { data, error, loading, notFound, fresh, refresh, failures };
}

/** Elapsed time as a duration: "just now", "5 min", "2 h", "3 d". */
export function durLabel(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / (24 * 60))} d`;
}

/** Elapsed time as a point in the past: "just now", "5 min ago". */
export function agoLabel(iso: string | null): string {
  const d = durLabel(iso);
  return d === "just now" || d === "never" ? d : `${d} ago`;
}
