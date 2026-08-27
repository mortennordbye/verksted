import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.css";
import type {
  BranchSync,
  FileDiff,
  FileContent,
  GitFileStatus,
  GitStatus,
  Memory,
  Session as SessionInfo,
  SessionFileDiff,
  Tree,
} from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import { diffLineClass } from "../diff";
import TopBar, { Badge, BackButton } from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
import ChangesPanel from "../components/ChangesPanel";
import ChatPane from "../components/ChatPane";
import BrowserPane from "../components/BrowserPane";
import FileTree from "../components/FileTree";
import GitPanel from "../components/GitPanel";
import SearchPanel from "../components/SearchPanel";
import PrPanel from "../components/PrPanel";
import ActionsPanel from "../components/ActionsPanel";
import Sheet from "../components/Sheet";
import { fileIcon } from "../fileicons";
import { useConfirm } from "../useConfirm";
import { useOverlayDismiss } from "../useDismissOnBack";

/** hljs language for a path, via its extension (aliases resolve: ts, py, yml…). */
function langFor(path: string): string | null {
  const name = path.split("/").at(-1)!.toLowerCase();
  const ext = name.split(".").at(-1)!;
  return hljs.getLanguage(ext) ? ext : null;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"]);

interface Viewed {
  path: string;
  content: string;
  kind: "text" | "diff" | "image";
}

/**
 * Publishes the visual viewport as `--vvh` (height) and `--vvt` (offset from the
 * layout viewport top). iOS Safari keeps `100dvh` — and the layout viewport —
 * at full height when the on-screen keyboard opens, so a terminal sized in dvh
 * puts the agent prompt underneath the keys. The visual viewport is the only
 * height that reflects the keyboard; sizing the screen to it (and never letting
 * the document scroll) keeps the prompt above the keyboard, and shrinking the
 * terminal box refits xterm, which resizes tmux to match.
 *
 * The screen only sizes to `--vvh` while `data-kbd` is set. With the keyboard
 * down it is `dvh`, which needs none of this and cannot go stale — see the
 * shell below.
 */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
      // The keyboard, as a boolean, for the `kbd` variant in theme.css. The
      // layout viewport keeps its full height while the visual one shrinks, so
      // the gap is the keyboard — 150px clears the browser's own toolbars,
      // which are what account for the difference when no keyboard is up.
      root.dataset.kbd = innerHeight - vv.height > 150 ? "1" : "";
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
      delete root.dataset.kbd;
    };
  }, []);
}

const SIDE_KEY = "vk.session.sideWidth";
const RATIO_KEY = "vk.session.ratio";
const VIEW_KEY = "vk.session.view";

/** What can occupy a pane. "chat" and "agent" are two views of the same one. */
type View = "chat" | "agent" | "shell" | "browser";

/**
 * The side pane's tabs. The key labels the desktop strip, where six of them
 * share a sidebar; the label and hint are for the phone's picker, which has
 * room to say what each one is.
 *
 * Pull requests and runs are the same panels the project screen carries. A
 * session is where the work that produces a PR actually happens, so needing to
 * leave it to see whether CI passed was the wrong way round.
 */
const SIDES = [
  { key: "files", label: "files", hint: "browse and edit the repo" },
  { key: "git", label: "git", hint: "what has changed, staged and committed" },
  { key: "changes", label: "changes", hint: "what this session itself committed" },
  { key: "search", label: "search", hint: "grep the repo" },
  { key: "prs", label: "pull requests", hint: "open PRs, their diffs, and merging" },
  { key: "runs", label: "actions", hint: "workflow runs, and the log of a failing job" },
] as const;
type Side = (typeof SIDES)[number]["key"];

/**
 * A glyph per pane, for the phone's picker and for the button that opens it.
 *
 * Nine rows set in the same weight of the same font take a read to tell apart,
 * and the picker is a thing you open several times a minute. The shape is what
 * you aim at the second time; the label stays, because a folder and a globe
 * carry meaning but "actions" and "pull requests" both look like arrows.
 */
const ICONS: Record<string, ReactNode> = {
  files: <path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2Z" />,
  git: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M6 9v6M18 9a9 9 0 0 1-9 9" />
      <circle cx="18" cy="6" r="3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.4-3.4" />
    </>
  ),
  // A commit on a line: what this session added to the history.
  changes: (
    <>
      <circle cx="12" cy="12" r="3.5" />
      <path d="M3 12h5.5M15.5 12H21" />
    </>
  ),
  prs: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="18" r="3" />
      <path d="M6 9v12M13 6h3a2 2 0 0 1 2 2v7" />
    </>
  ),
  runs: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8 6 4-6 4Z" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  agent: <path d="m4 17 6-6-6-6M12 19h8" />,
  shell: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m7 9 3 3-3 3M13 15h4" />
    </>
  ),
  browser: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z" />
    </>
  ),
};

function PaneIcon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`flex-none ${className ?? ""}`}
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}

/** A persisted layout number, clamped — localStorage is user-editable. */
function storedNumber(key: string, fallback: number, min: number, max: number): number {
  const n = Number(localStorage.getItem(key));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export default function Session() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  useVisualViewport();
  // Set when this screen was reached by creating the session: says whether the
  // repo was actually moved to an up-to-date main.
  const location = useLocation();
  const { sync } = (location.state ?? {}) as { sync?: BranchSync };
  const [syncNote, setSyncNote] = useState(sync?.status === "synced" ? null : (sync ?? null));
  // ?side=changes is how the inbox links straight to a finished run's diff:
  // arriving at the terminal of a session that has none is a dead end on a
  // phone, where the sidebar is a tab rather than a column.
  const wantsSide = new URLSearchParams(location.search).get("side");
  const { data: session } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const { data: tree, refresh: refreshTree } = usePoll<Tree>(
    session ? `/api/projects/${session.project}/tree` : null,
    8_000,
  );
  const { data: git, refresh: refreshGit } = usePoll<GitStatus>(
    session ? `/api/projects/${session.project}/git` : null,
    8_000,
  );
  // The badge the top bar carried, which this screen no longer shows on a
  // phone — so the count has to reach the ⋯ that took the bar's place. The bar
  // keeps its own poll for every other screen; one extra GET every two minutes
  // on a desktop session is cheaper than a context for two call sites.
  const { data: proposed } = usePoll<{ proposals: Memory[] }>("/api/memory/proposed", 120_000);
  const waiting = proposed?.proposals.length ?? 0;
  const [pane, setPane] = useState<"tree" | "term">(wantsSide === "changes" ? "tree" : "term");
  const [side, setSide] = useState<Side>(wantsSide === "changes" ? "changes" : "files");
  // Companion panes next to the agent terminal; on desktop all three can
  // share the screen, on mobile exactly one is visible at a time.
  const [shell, setShell] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [active, setActive] = useState<"agent" | "shell" | "browser">("agent");

  /** Mobile pane picker: mounts the picked pane, unmounts the other companion
      (a hidden browser would keep streaming frames to a pocketed phone). */
  function pick(p: "agent" | "shell" | "browser") {
    setActive(p);
    setShell(p === "shell");
    setBrowser(p === "browser");
  }
  /**
   * Whether the main pane shows the conversation or the terminal. Remembered
   * per device: whichever one a person reads in, they read in it every time,
   * and it used to reset on every navigation between sessions.
   */
  const [main, setMain] = useState<"agent" | "chat">(() =>
    localStorage.getItem(VIEW_KEY) === "chat" ? "chat" : "agent",
  );
  useEffect(() => localStorage.setItem(VIEW_KEY, main), [main]);
  const [full, setFull] = useState(false);
  // Sidebar width and the split ratio are per-device preferences that used to
  // reset on every navigation between sessions.
  const [sideWidth, setSideWidth] = useState(() => storedNumber(SIDE_KEY, 250, 160, 640));
  /**
   * Floor for the column. The PR and run panels came from a full-width screen;
   * at the 250px default every run row wrapped to four lines. Applied as a
   * minimum rather than a resize, so the stored width survives switching tabs.
   */
  const sideMin = side === "prs" || side === "runs" ? 340 : 160;
  const sideShown = Math.max(sideWidth, sideMin);
  const sideDrag = useRef(false);

  useEffect(() => localStorage.setItem(SIDE_KEY, String(sideWidth)), [sideWidth]);

  // Full screen could only be left with the small ⛶ button; Escape is what
  // every other full-screen surface on a desktop answers to.
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [full]);
  const [menu, setMenu] = useState(false);
  const [picker, setPicker] = useState(false);
  // Agent-pane share of the split, in %. Adjusted by dragging the divider.
  const [ratio, setRatio] = useState(() => storedNumber(RATIO_KEY, 50, 20, 80));
  useEffect(() => localStorage.setItem(RATIO_KEY, String(ratio)), [ratio]);
  const splitBox = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const [file, setFile] = useState<Viewed | null>(null);
  // The file viewer could only be closed by pointer: no Escape, and Back left
  // the session entirely rather than closing it.
  useOverlayDismiss(
    file !== null,
    useCallback(() => setFile(null), []),
  );
  const [confirm, confirmDialog] = useConfirm();

  async function openFile(path: string) {
    if (!session) return;
    if (IMAGE_EXTS.has(path.split(".").at(-1)!.toLowerCase())) {
      setFile({ path, content: "", kind: "image" });
      return;
    }
    try {
      const f = await api<FileContent>(
        `/api/projects/${session.project}/file?path=${encodeURIComponent(path)}`,
      );
      setFile({ ...f, kind: "text" });
    } catch (e) {
      setFile({ path, content: `— ${(e as Error).message} —`, kind: "text" });
    }
  }

  async function openDiff(f: GitFileStatus) {
    if (!session) return;
    try {
      const d = await api<FileDiff>(
        `/api/projects/${session.project}/diff?path=${encodeURIComponent(f.path)}${f.staged ? "&staged=true" : ""}`,
      );
      setFile({ path: f.path, content: d.diff || "— no changes —", kind: "diff" });
    } catch (e) {
      setFile({ path: f.path, content: `— ${(e as Error).message} —`, kind: "diff" });
    }
  }

  /** One file's diff over the session's own commit range, not the working tree. */
  async function openRangeDiff(path: string) {
    if (!session) return;
    try {
      const d = await api<SessionFileDiff>(
        `/api/sessions/${session.id}/changes/diff?path=${encodeURIComponent(path)}`,
      );
      setFile({
        path,
        content: d.diff
          ? d.diff + (d.truncated ? "\n— too long, the rest is in the terminal —" : "")
          : "— no changes —",
        kind: "diff",
      });
    } catch (e) {
      setFile({ path, content: `— ${(e as Error).message} —`, kind: "diff" });
    }
  }

  async function uploadFile(f: File) {
    if (!session) return;
    // The result was never checked, so a rejected upload — too large, denied
    // path, no disk — looked exactly like a successful one.
    const res = await fetch(
      `/api/projects/${session.project}/file?path=${encodeURIComponent(f.name)}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: f },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(body?.error ?? `upload failed (HTTP ${res.status})`);
    }
  }

  async function kill() {
    if (!session) return;
    const ok = await confirm({
      title: "Kill this session?",
      body: "The tmux session and the agent inside it end. The session stays in history.",
      action: "kill the session",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/sessions/${session.id}`, { method: "DELETE" });
    void navigate(`/p/${session.project}`);
  }

  async function deleteSession() {
    if (!session) return;
    const live = session.status !== "done";
    const ok = await confirm({
      title: live ? "Kill and delete this session?" : "Delete this session?",
      body: live
        ? "The tmux session and the agent inside it end, and the session is removed from history. This cannot be undone."
        : "It is removed from history. This cannot be undone.",
      action: live ? "kill and delete" : "delete",
      danger: true,
    });
    if (!ok) return;
    await api(`/api/sessions/${session.id}?purge=1`, { method: "DELETE" });
    void navigate(`/p/${session.project}`);
  }

  const live = session != null && session.status !== "done";
  // Only claude writes the transcript the chat view reads back.
  const hasChat = session?.agent === "claude";
  const chatView = hasChat && main === "chat";

  /** The views this session can show, in the order the pickers list them. */
  const views: View[] = [
    ...(hasChat ? (["chat"] as const) : []),
    "agent",
    ...(live ? (["shell", "browser"] as const) : []),
  ];
  const viewLabel = (v: View) =>
    v === "agent" ? (live ? (session?.agent ?? "agent") : "terminal") : v;
  // "chat" and "agent" share the main pane, so which of them is on is `main`.
  const viewOn = (v: View) =>
    v === "chat" || v === "agent"
      ? active === "agent" && chatView === (v === "chat")
      : active === v;
  const pickView = (v: View) => {
    if (v === "chat" || v === "agent") {
      pick("agent");
      setMain(v);
    } else {
      pick(v);
    }
  };
  const viewHint = (v: View) =>
    v === "chat"
      ? "the conversation, without the terminal"
      : v === "agent"
        ? live
          ? "the agent's tmux session"
          : "the terminal, read only"
        : v === "shell"
          ? "a plain shell in the repo"
          : "the session's headless browser";
  /** What the phone's pane button says it is showing. */
  const currentPaneLabel =
    pane === "tree"
      ? (SIDES.find((sd) => sd.key === side)?.label ?? "files")
      : viewLabel(views.find(viewOn) ?? "agent");
  // "chat" and "agent" are icons of their own; every other view is its own key.
  const currentPaneKey = pane === "tree" ? side : (views.find(viewOn) ?? "agent");

  // hljs escapes the source; the produced HTML is only span tags with classes.
  const highlighted = useMemo(() => {
    if (!file || file.kind !== "text") return null;
    const lang = langFor(file.path);
    return lang ? hljs.highlight(file.content, { language: lang }).value : null;
  }, [file]);

  return (
    <>
      {/* Phone: exactly one visual viewport tall, and the document never
          scrolls — the terminal takes whatever room the keyboard leaves.
          Desktop keeps the ordinary scrolling page.

          Two viewports, each used for the one thing it knows. `dvh` follows the
          browser's own toolbars retracting and expanding and is deliberately
          blind to the keyboard; the visual viewport is the reverse. So the
          shell is `dvh` until the keyboard is up, which is what stops it
          ending short of the screen by whatever the visual viewport is not
          counting — and switches to `--vvh` under `kbd:`, where the keyboard is
          the only thing that matters.

          Pinned to `--vvt` there, not to the top of the page: iOS pans the
          visual viewport inside a layout viewport that stays put, so a shell
          anchored at layout-y 0 slides out from under the screen the moment the
          keyboard opens — with the chat composer focused, what was left on
          screen was the shell's bottom edge and black beneath it. `fixed`
          positions against the layout viewport, which is what makes the offset
          the whole correction.

          `kbd:desk:h-auto` is not decoration: `kbd` is an attribute selector
          and outranks `desk`'s media query, so without it a tablet with a
          keyboard up gets a `static` element holding a fixed height. `top`
          needs no such guard — `desk:static` makes it inert. */}
      <div className="fixed inset-x-0 top-0 flex h-dvh flex-col overflow-hidden kbd:top-[var(--vvt,0px)] kbd:h-[var(--vvh,100dvh)] kbd:desk:h-auto desk:static desk:h-auto desk:overflow-visible">
        {/* Gone from a phone, not just while the keyboard is up. It is 75px of
            pure navigation stacked on top of a row that was already there, and
            on an 874px screen that is a twelfth of everything before the first
            terminal line. The row below carries its jobs: the back arrow and
            the session name in the row itself, the way home and the inbox and
            settings in the sheet its ⋯ opens. */}
        <TopBar
          className="hidden desk:flex"
          back={session ? `/p/${session.project}` : "/"}
          crumb={
            session
              ? [{ label: session.project, to: `/p/${session.project}` }, { label: session.title }]
              : []
          }
        />
        {/* max-w to match the other screens: without it the kill and delete
            buttons sat a screen-width away from the title on an ultrawide. */}
        {/* No bottom padding on a phone: it was holding the pane box ~34px clear
            of the screen edge for the home indicator, which is 34px of terminal
            or conversation spent on a band that is already black. The inset
            moves inside the box instead (see the pane box below), so the box's
            own background bleeds under the indicator and the content stops
            above it. */}
        {/* And the top inset, which the top bar used to pay and no longer can
            on a phone: without it the row below lands under the status bar,
            where a tap does not reach the page at all. `max(10px, …)` is
            exactly the old pt-2.5 wherever there is no inset. */}
        <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col px-[18px] pt-[max(10px,env(safe-area-inset-top))] pb-0 kbd:pt-2.5 desk:pt-[18px] desk:pb-6">
          {/* Phone folds this row into the pane strip below: four stacked bars
              before the first terminal row left the agent a fifth of the
              screen. The title lives in the top bar crumb there instead. */}
          <div className="mb-2 hidden flex-none items-center gap-2 desk:mb-3.5 desk:flex desk:flex-wrap desk:gap-3">
            <StatusDot running={live} />
            <h1 className="min-w-0 truncate font-mono text-[14px] font-semibold desk:text-[16px]">
              {session?.title ?? "…"}
            </h1>
            {session && <AgentTag agent={session.agent} />}
            {session && (
              <StatusChip
                kind={
                  session.status === "running"
                    ? "run"
                    : session.status === "waiting"
                      ? "wait"
                      : "idle"
                }
                label={live ? `${session.status} · ${durLabel(session.createdAt)}` : "done"}
              />
            )}
            {git && (
              <span className="hidden font-mono text-[12px] text-muted desk:inline">
                ⎇ {git.branch}
                {git.files.length > 0 ? "*" : ""}
              </span>
            )}
            {session && (
              <button
                onClick={() => setMenu(true)}
                aria-label="session actions"
                className="ml-auto flex-none rounded-[7px] border border-line bg-surface px-2.5 py-1 font-mono text-[13px] text-muted hover:border-faint hover:text-text"
              >
                ⋯
              </button>
            )}
          </div>

          {syncNote && (
            <div className="mb-2 flex flex-none items-center gap-2 rounded-lg border border-wait/40 bg-wait/5 px-3 py-1.5 font-mono text-[12px] text-wait">
              <span className="min-w-0 flex-1 truncate">
                {syncNote.status === "failed" ? "could not sync" : "not synced"} to main:{" "}
                {syncNote.detail} · on ⎇ {syncNote.branch}
              </span>
              <button
                onClick={() => setSyncNote(null)}
                aria-label="dismiss"
                className="flex-none px-1 text-faint hover:text-text"
              >
                ✕
              </button>
            </div>
          )}

          {/* Phone: one control for every pane. Desktop shows the sidebar and
              the terminal side by side instead, and picks companions in the box.

              This was a row of tabs in a horizontal scroller. A claude session
              carries five of them, which on a 390px screen meant the last two
              were off the edge and reachable only by dragging a strip two
              buttons tall — a gesture nothing on the page advertised, sitting
              directly above a terminal that also scrolls. One button that says
              what you are looking at, opening a list, costs one tap and hides
              nothing. */}
          {/* Gone with the keyboard up, the way the top bar used to be: under
              the keyboard-up top padding this row would sit inside the status
              bar strip, visible and unhittable, which is worse than absent.
              Dismissing the keyboard brings it straight back. */}
          <div className="mb-2 flex flex-none items-center gap-2.5 kbd:hidden desk:hidden">
            <BackButton to={session ? `/p/${session.project}` : "/"} />
            <button
              onClick={() => setPicker(true)}
              aria-haspopup="dialog"
              aria-expanded={picker}
              // Not `flex-none` any more: it holds its content width while
              // there is room, and gives once the title beside it has already
              // shrunk to nothing. Its label is truncated either way, so a
              // long pane name costs the title rather than the row.
              className="tap flex min-w-0 items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13.5px] font-semibold hover:border-line-strong"
            >
              <PaneIcon name={currentPaneKey} className="text-muted" />
              <span className="truncate">{currentPaneLabel}</span>
              <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="flex-none text-faint"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            {/* The last crumb, which is where this screen's name lived until the
                top bar left the phone. `flex-1` from a zero basis, so it is the
                slack in the row rather than a claim on it: the pane label keeps
                its own width and the title takes whatever is left, down to
                nothing. On a narrow row that is the first few characters, and
                the whole of it is the heading of the sheet the ⋯ opens. */}
            <h1 className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted">
              {session?.title ?? "…"}
            </h1>
            {session && (
              // Doubles as the actions trigger: two separate controls plus the
              // tabs don't fit a phone width, and the sheet repeats the status.
              <button
                onClick={() => setMenu(true)}
                // The zero case stays exactly "session actions" — it is what
                // the e2e suite reaches this sheet by.
                aria-label={
                  waiting ? `session actions, ${waiting} waiting in the inbox` : "session actions"
                }
                // Bordered and 44px like everything beside it. It used to be a
                // bare chip with a 13px ⋯ next to it, about 26px tall and 6px
                // from the full-screen button — the way to delete a session,
                // and it read as decoration wedged between two real controls.
                className="tap relative ml-auto flex flex-none items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5"
              >
                <StatusChip
                  kind={
                    session.status === "running"
                      ? "run"
                      : session.status === "waiting"
                        ? "wait"
                        : "idle"
                  }
                  label={live ? session.status : "done"}
                />
                <span className="font-mono text-[15px] leading-none text-muted">⋯</span>
                {/* The inbox count, which lost its home when the top bar left.
                    It rides here so the one thing that arrives without a
                    session to announce it still interrupts, at no width. */}
                <Badge count={waiting} />
              </button>
            )}
          </div>

          <div
            className="grid min-h-0 flex-1 items-stretch gap-3 desk:items-start desk:grid-cols-[var(--side)_1fr]"
            style={{ "--side": `${sideShown}px` } as React.CSSProperties}
          >
            <div
              className={`${pane === "tree" ? "flex" : "hidden desk:flex"} relative min-h-0 min-w-0 flex-col desk:h-[calc(var(--vvh,100dvh)-200px)]`}
            >
              {/* The sidebar was a fixed 250px: deep trees scrolled inside it
                  while a wide monitor sat empty. Absolutely positioned on the
                  edge rather than a third grid column, so the mobile stacking
                  of this grid is untouched. */}
              {/* A focusable separator is the WAI-ARIA window splitter pattern: it is an
                  interactive widget, and the valuenow/min/max and arrow-key handling that
                  pattern asks for is all right here. The rule only knows that "separator"
                  is non-interactive by default. */}
              {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
              <div
                onPointerDown={(e) => {
                  sideDrag.current = true;
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={(e) => {
                  if (!sideDrag.current) return;
                  const left = e.currentTarget.parentElement!.getBoundingClientRect().left;
                  setSideWidth(Math.min(640, Math.max(sideMin, e.clientX - left)));
                }}
                onPointerUp={(e) => {
                  sideDrag.current = false;
                  e.currentTarget.releasePointerCapture(e.pointerId);
                }}
                onDoubleClick={() => setSideWidth(Math.max(250, sideMin))}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") setSideWidth((w) => Math.max(sideMin, w - 16));
                  else if (e.key === "ArrowRight") setSideWidth((w) => Math.min(640, w + 16));
                  else if (e.key === "Home") setSideWidth(Math.max(250, sideMin));
                  else return;
                  e.preventDefault();
                }}
                role="separator"
                aria-orientation="vertical"
                aria-label="resize the sidebar"
                aria-valuenow={sideShown}
                aria-valuemin={sideMin}
                aria-valuemax={640}
                // Being focusable is what makes the splitter usable without a mouse.
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                tabIndex={0}
                title="drag to resize · double-click to reset · arrow keys"
                className="absolute top-0 -right-2.5 bottom-0 z-10 hidden w-2 cursor-col-resize touch-none hover:bg-accent/60 desk:block"
              />
              <div
                role="group"
                aria-label="side panel"
                className="mb-2 flex flex-none flex-wrap gap-1.5"
              >
                {SIDES.map(({ key: t }) => (
                  <button
                    key={t}
                    aria-pressed={side === t}
                    onClick={() => setSide(t)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] ${
                      side === t
                        ? "border-accent bg-surface-2 text-text"
                        : "border-line bg-surface text-muted"
                    }`}
                  >
                    {t}
                    {t === "git" && (git?.files.length ?? 0) > 0 && (
                      <span className="ml-1 text-wait">{git!.files.length}</span>
                    )}
                  </button>
                ))}
              </div>
              {side === "files" && (
                <FileTree
                  title={session ? `~/${session.project}` : "…"}
                  nodes={tree?.nodes ?? null}
                  truncated={tree?.truncated ?? false}
                  onOpenFile={openFile}
                  onUpload={async (f) => {
                    await uploadFile(f);
                    refreshTree();
                  }}
                />
              )}
              {side === "git" && session && (
                <GitPanel
                  project={session.project}
                  status={git}
                  onOpenDiff={openDiff}
                  onRefresh={refreshGit}
                />
              )}
              {side === "search" && session && (
                <SearchPanel project={session.project} onOpenFile={openFile} />
              )}
              {side === "changes" && session && (
                <ChangesPanel sessionId={session.id} live={live} onOpenDiff={openRangeDiff} />
              )}
              {/* Both scroll on their own: the side column is a fixed height on
                  desktop, and a PR list with its diffs is taller than it. */}
              {side === "prs" && session && (
                <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
                  <PrPanel
                    project={session.project}
                    // A checkout or a merge moves the working tree this session
                    // is sitting in, so the git strip and the file tree are both
                    // stale the moment it returns.
                    onChanged={() => {
                      refreshGit();
                      refreshTree();
                    }}
                  />
                </div>
              )}
              {side === "runs" && session && (
                <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
                  <ActionsPanel project={session.project} />
                </div>
              )}
            </div>

            <div
              className={
                full
                  ? // The visual viewport spans the whole screen, notch and home
                    // indicator included, so full screen has to inset itself —
                    // otherwise the pane strip lands under the status bar and
                    // the terminal's last row under the home indicator.
                    "fixed inset-x-0 top-0 z-50 flex h-dvh flex-col overflow-hidden bg-term pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] kbd:top-[var(--vvt,0px)] kbd:h-[var(--vvh,100dvh)] kbd:pt-0 kbd:pb-0"
                  : // Square-bottomed and edge-to-edge on a phone, because it now
                    // ends where the screen does; the home-indicator inset is
                    // padding inside it, so its own background carries under the
                    // indicator and its last line stops above it. `kbd:pb-0`
                    // because that inset does not fall to zero when the keyboard
                    // covers the indicator, and the band it reserves is the
                    // conversation you are typing into.
                    `${pane === "term" ? "flex" : "hidden desk:flex"} min-h-0 flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-term pb-[env(safe-area-inset-bottom)] kbd:pb-0 desk:rounded-xl desk:border-b desk:pb-0 desk:h-[calc(var(--vvh,100dvh)-200px)] desk:min-h-[380px]`
              }
            >
              {/* On a phone the pane strip above the box carries these controls,
                  so the row only costs rows there when it's the way out of full. */}
              <div
                className={`${full ? "flex" : "hidden desk:flex"} flex-none items-center gap-2.5 border-b border-line bg-surface px-3.5 py-[9px] font-mono text-[11.5px] text-faint`}
              >
                <span className="hidden text-muted desk:inline">
                  {chatView ? "chat" : "tmux"} · {session?.id ?? "…"}
                </span>
                {/* Mobile: one pane at a time, these switch between them. Kept
                    for full screen, which hides the strip above the box. */}
                <span role="group" aria-label="pane" className="flex gap-1.5 desk:hidden">
                  {views.map((v) => (
                    <button
                      key={v}
                      aria-pressed={viewOn(v)}
                      onClick={() => pickView(v)}
                      className={`rounded-[5px] border px-2 py-0.5 ${
                        viewOn(v)
                          ? "border-accent bg-surface-2 text-text"
                          : "border-line text-muted"
                      }`}
                    >
                      {viewLabel(v)}
                    </button>
                  ))}
                </span>
                <span className="ml-auto flex items-center gap-2">
                  {hasChat && (
                    // The one control this whole view is for: the same session,
                    // read instead of driven.
                    <span
                      role="group"
                      aria-label="main pane view"
                      className="hidden gap-1.5 desk:flex"
                    >
                      {(["chat", "agent"] as const).map((v) => (
                        <button
                          key={v}
                          aria-pressed={chatView === (v === "chat")}
                          onClick={() => setMain(v)}
                          className={`rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${
                            chatView === (v === "chat")
                              ? "border-accent bg-surface-2 text-text"
                              : "border-line text-muted"
                          }`}
                        >
                          {v === "chat" ? "chat" : "terminal"}
                        </button>
                      ))}
                    </span>
                  )}
                  {live && (
                    <span className="hidden gap-2 desk:flex">
                      <button
                        onClick={() => setShell((s) => !s)}
                        className={`rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${shell ? "border-accent text-text" : "border-line"}`}
                      >
                        {shell ? "✕ shell" : "▚ shell"}
                      </button>
                      <button
                        onClick={() => setBrowser((b) => !b)}
                        className={`rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${browser ? "border-accent text-text" : "border-line"}`}
                      >
                        {browser ? "✕ browser" : "◫ browser"}
                      </button>
                    </span>
                  )}
                  <button
                    onClick={() => setFull((f) => !f)}
                    className="rounded-[5px] border border-line px-2 py-0.5 hover:border-faint hover:text-text"
                  >
                    {full ? "✕ full" : "⛶ full"}
                  </button>
                  <span className="hidden desk:inline">{session?.agent}</span>
                </span>
              </div>
              {session && (
                <div ref={splitBox} className="flex min-h-0 flex-1 flex-col desk:flex-row">
                  <div
                    className={`${active === "agent" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 desk:flex ${shell || browser ? "desk:flex-none" : ""}`}
                    style={shell || browser ? { flexBasis: `${ratio}%` } : undefined}
                  >
                    {/* The transcript outlives tmux, so an ended session has a
                          conversation to read even though it has no terminal. */}
                    {chatView ? (
                      <ChatPane session={session} />
                    ) : live ? (
                      <Terminal sessionId={session.id} project={session.project} />
                    ) : (
                      <div className="flex flex-1 items-center justify-center font-mono text-[13px] text-faint">
                        session ended {session.endedAt ? agoLabel(session.endedAt) : ""}
                      </div>
                    )}
                  </div>
                  {(shell || browser) && (
                    // The WAI-ARIA window splitter pattern again; see the sidebar
                    // separator above.
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
                    <div
                      onPointerDown={(e) => {
                        dragging.current = true;
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      onPointerMove={(e) => {
                        if (!dragging.current || !splitBox.current) return;
                        const box = splitBox.current.getBoundingClientRect();
                        const pct = ((e.clientX - box.left) / box.width) * 100;
                        setRatio(Math.min(80, Math.max(20, pct)));
                      }}
                      onPointerUp={(e) => {
                        dragging.current = false;
                        e.currentTarget.releasePointerCapture(e.pointerId);
                      }}
                      onDoubleClick={() => setRatio(50)}
                      onKeyDown={(e) => {
                        if (e.key === "ArrowLeft") setRatio((r) => Math.max(20, r - 2));
                        else if (e.key === "ArrowRight") setRatio((r) => Math.min(80, r + 2));
                        else if (e.key === "Home") setRatio(50);
                        else return;
                        e.preventDefault();
                      }}
                      // A 6px drag target was the only way to move this, which
                      // is no way at all without a mouse.
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="resize the agent pane"
                      aria-valuenow={Math.round(ratio)}
                      aria-valuemin={20}
                      aria-valuemax={80}
                      // Being focusable is what makes the splitter usable without a mouse.
                      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                      tabIndex={0}
                      title="drag to resize · double-click to reset · arrow keys"
                      className="hidden w-1.5 flex-none cursor-col-resize touch-none bg-line hover:bg-accent/60 desk:block"
                    />
                  )}
                  {shell && (
                    <div
                      className={`${active === "shell" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 desk:flex`}
                    >
                      <Terminal sessionId={session.id} project={session.project} shell />
                    </div>
                  )}
                  {browser && (
                    <div
                      className={`${active === "browser" ? "flex" : "hidden"} min-h-0 min-w-0 flex-1 desk:flex ${shell ? "desk:border-l desk:border-line" : ""}`}
                    >
                      <BrowserPane sessionId={session.id} />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </main>
      </div>

      {picker && (
        <Sheet title="view" sub="what this pane shows" onClose={() => setPicker(false)}>
          <div className="flex flex-col gap-2">
            {[
              ...SIDES.map((sd) => ({
                key: sd.key,
                label: sd.label,
                hint: sd.hint,
                on: pane === "tree" && side === sd.key,
                go: () => {
                  setPane("tree");
                  setSide(sd.key);
                },
              })),
              ...views.map((v) => ({
                key: v,
                label: viewLabel(v),
                hint: viewHint(v),
                on: pane === "term" && viewOn(v),
                go: () => {
                  setPane("term");
                  pickView(v);
                },
              })),
            ].map((o) => (
              <button
                key={o.key}
                aria-pressed={o.on}
                onClick={() => {
                  o.go();
                  setPicker(false);
                }}
                className={`tap flex w-full items-center gap-3 rounded-lg border px-3.5 py-3 text-left ${
                  o.on ? "border-accent bg-accent-tint" : "border-line hover:border-line-strong"
                }`}
              >
                <PaneIcon name={o.key} className={o.on ? "text-accent" : "text-faint"} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{o.label}</span>
                  <span className="block text-[12.5px] text-faint">{o.hint}</span>
                </span>
                {o.on && (
                  <svg
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="flex-none text-accent"
                    aria-hidden="true"
                  >
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {menu && session && (
        <Sheet
          title={session.title}
          sub={`${session.agent} · ${live ? session.status : "done"}${git ? ` · ⎇ ${git.branch}${git.files.length > 0 ? "*" : ""}` : ""}`}
          onClose={() => setMenu(false)}
        >
          {/* What the top bar carried before this screen stopped showing one on
              a phone — the way home, the inbox and its count, settings — plus
              full screen, which gave up its place in the row to the back arrow.
              It buys ~52px now rather than the ~160px it used to, and it is a
              mode you enter once; the way out of it is the pane strip's own
              ✕ full, which is untouched. */}
          <div className="mb-2 flex flex-col gap-2 desk:hidden">
            <button
              onClick={() => {
                setMenu(false);
                setFull(true);
              }}
              className="tap w-full rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-line-strong hover:text-text"
            >
              ⛶ full screen
            </button>
            <Link
              to="/"
              aria-label="verksted — home"
              className="tap flex w-full items-center justify-center rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-line-strong hover:text-text"
            >
              verksted — home
            </Link>
            <Link
              to="/runs"
              className="tap flex w-full items-center justify-center rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-line-strong hover:text-text"
            >
              inbox{waiting ? ` · ${waiting} waiting` : ""}
            </Link>
            <Link
              to="/settings"
              className="tap flex w-full items-center justify-center rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-line-strong hover:text-text"
            >
              settings
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            {live && (
              <button
                onClick={() => {
                  setMenu(false);
                  void kill();
                }}
                className="w-full rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait"
              >
                kill session
              </button>
            )}
            <button
              onClick={() => {
                setMenu(false);
                void deleteSession();
              }}
              className="w-full rounded-lg border border-line px-3.5 py-2.5 font-mono text-[13px] text-muted hover:border-wait hover:text-wait"
            >
              delete session
            </button>
          </div>
        </Sheet>
      )}

      {file && (
        <div
          // Presentational: clicking away duplicates Escape, Back and the ✕.
          role="presentation"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
          onClick={(e) => e.target === e.currentTarget && setFile(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={file.path}
            className="flex h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-line bg-surface"
          >
            <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
              <img
                src={fileIcon(file.path.split("/").at(-1)!)}
                alt=""
                className="h-4 w-4 flex-none"
              />
              <span className="min-w-0 truncate">{file.path}</span>
              {file.kind === "diff" && (
                <span className="flex-none text-[10px] text-faint">diff</span>
              )}
              {session && file.kind !== "diff" && (
                <a
                  href={`/api/projects/${session.project}/raw?path=${encodeURIComponent(file.path)}&download=1`}
                  title="download"
                  className="ml-auto flex-none px-2 text-faint hover:text-text"
                >
                  ⤓
                </a>
              )}
              <button
                onClick={() => setFile(null)}
                className={`${file.kind === "diff" ? "ml-auto" : ""} flex-none px-2 text-faint hover:text-text`}
              >
                ✕
              </button>
            </div>
            {file.kind === "image" && session ? (
              <div className="flex flex-1 items-center justify-center overflow-auto bg-term p-4">
                <img
                  src={`/api/projects/${session.project}/raw?path=${encodeURIComponent(file.path)}`}
                  alt={file.path}
                  className="max-h-full max-w-full"
                />
              </div>
            ) : file.kind === "diff" ? (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {file.content.split("\n").map((line, i) => (
                  <div key={i} className={diffLineClass(line)}>
                    {line || " "}
                  </div>
                ))}
              </pre>
            ) : highlighted !== null ? (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                <code
                  className="hljs !bg-transparent"
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              </pre>
            ) : (
              <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-text">
                {file.content}
              </pre>
            )}
          </div>
        </div>
      )}
      {confirmDialog}
    </>
  );
}
