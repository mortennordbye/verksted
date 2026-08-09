import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark-dimmed.css";
import type {
  BranchSync,
  FileDiff,
  FileContent,
  GitFileStatus,
  GitStatus,
  Session as SessionInfo,
  Tree,
} from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import { diffLineClass } from "../diff";
import TopBar from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
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
 */
function useVisualViewport() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--vvh", `${vv.height}px`);
      root.style.setProperty("--vvt", `${vv.offsetTop}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
      root.style.removeProperty("--vvh");
      root.style.removeProperty("--vvt");
    };
  }, []);
}

const SIDE_KEY = "vk.session.sideWidth";
const RATIO_KEY = "vk.session.ratio";
const VIEW_KEY = "vk.session.view";

/** What can occupy a pane. "chat" and "agent" are two views of the same one. */
type View = "chat" | "agent" | "shell" | "browser";

/**
 * The side pane's tabs. The key labels the desktop strip, where five of them
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
  { key: "search", label: "search", hint: "grep the repo" },
  { key: "prs", label: "pull requests", hint: "open PRs, their diffs, and merging" },
  { key: "runs", label: "actions", hint: "workflow runs, and the log of a failing job" },
] as const;
type Side = (typeof SIDES)[number]["key"];

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
  const { sync } = (useLocation().state ?? {}) as { sync?: BranchSync };
  const [syncNote, setSyncNote] = useState(sync?.status === "synced" ? null : (sync ?? null));
  const { data: session } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const { data: tree, refresh: refreshTree } = usePoll<Tree>(
    session ? `/api/projects/${session.project}/tree` : null,
    8_000,
  );
  const { data: git, refresh: refreshGit } = usePoll<GitStatus>(
    session ? `/api/projects/${session.project}/git` : null,
    8_000,
  );
  const [pane, setPane] = useState<"tree" | "term">("term");
  const [side, setSide] = useState<Side>("files");
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
          Desktop keeps the ordinary scrolling page. */}
      <div className="flex h-[var(--vvh,100dvh)] flex-col overflow-hidden desk:h-auto desk:overflow-visible">
        <TopBar
          back={session ? `/p/${session.project}` : "/"}
          crumb={session ? [session.project, session.title] : []}
        />
        {/* max-w to match the other screens: without it the kill and delete
            buttons sat a screen-width away from the title on an ultrawide. */}
        <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col px-[18px] pt-2.5 pb-[max(10px,env(safe-area-inset-bottom))] desk:pt-[18px] desk:pb-6">
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
          <div className="mb-2 flex flex-none items-center gap-1.5 desk:hidden">
            <button
              onClick={() => setPicker(true)}
              aria-haspopup="dialog"
              aria-expanded={picker}
              className="tap flex min-w-0 flex-none items-center gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-[13.5px] font-semibold hover:border-line-strong"
            >
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
            {session && (
              // Doubles as the actions trigger: two separate controls plus the
              // tabs don't fit a phone width, and the sheet repeats the status.
              <button
                onClick={() => setMenu(true)}
                aria-label="session actions"
                className="ml-auto flex flex-none items-center gap-1"
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
                <span className="font-mono text-[13px] text-muted">⋯</span>
              </button>
            )}
            <button
              onClick={() => setFull(true)}
              aria-label="full screen"
              className={`${session ? "" : "ml-auto"} flex-none rounded-lg border border-line bg-surface px-3 py-1.5 font-mono text-[12.5px] text-muted`}
            >
              ⛶
            </button>
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
                    "fixed inset-x-0 top-[var(--vvt,0px)] z-50 flex h-[var(--vvh,100dvh)] flex-col overflow-hidden bg-term pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
                  : `${pane === "term" ? "flex" : "hidden desk:flex"} min-h-0 flex-col overflow-hidden rounded-xl border border-line bg-term desk:h-[calc(var(--vvh,100dvh)-200px)] desk:min-h-[380px]`
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
