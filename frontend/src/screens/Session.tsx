import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import type {
  BranchSync,
  GitFileStatus,
  GitStatus,
  Session as SessionInfo,
  Tree,
} from "../../../shared/api";
import { agoLabel, api, durLabel, usePoll } from "../api";
import { Badge, useNeedsYou } from "../components/Tabs";
import TopBar, { BackButton } from "../components/TopBar";
import { AgentTag, StatusChip, StatusDot } from "../components/StatusChip";
import Terminal from "../components/Terminal";
import ChangesPanel from "../components/ChangesPanel";
import ChatPane from "../components/ChatPane";
import BrowserPane from "../components/BrowserPane";
import FileTree from "../components/FileTree";
import FileViewer, { type FileTarget } from "../components/FileViewer";
import GitPanel from "../components/GitPanel";
import SearchPanel from "../components/SearchPanel";
import Splitter from "../components/Splitter";
import PrPanel from "../components/PrPanel";
import ActionsPanel from "../components/ActionsPanel";
import Sheet from "../components/Sheet";
import Icon, { type IconName } from "../components/Icon";
import PageHeader from "../components/PageHeader";
import SegTabs from "../components/ui/SegTabs";
import Skeleton from "../components/Skeleton";
import { readStoredNumber, readStored, writeStored } from "../storage";
import { useAction } from "../useAction";
import { useConfirm } from "../useConfirm";
import { overlaysSettled } from "../useDismissOnBack";
import { useUrlOverlay } from "../useUrlOverlay";
// The screen only sizes to `--vvh` while `data-kbd` is set. With the keyboard
// down it is `dvh`, which needs none of this and cannot go stale — see the
// shell below.
import { useVisualViewport } from "../useVisualViewport";
import Button, { buttonClass } from "../components/ui/Button";
import Notice from "../components/ui/Notice";
import PollError from "../components/PollError";

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
/**
 * Which drawn icon stands for each pane and side tab. The screen used to carry
 * its own icon set and its own svg wrapper beside Icon.tsx, the same idea twice.
 */
const PANE_ICON: Record<string, IconName> = {
  files: "folder",
  git: "git",
  search: "search",
  changes: "changes",
  prs: "pr",
  runs: "play",
  chat: "chat",
  agent: "terminal",
  shell: "shell",
  browser: "browser",
};

function PaneIcon({
  name,
  size = 17,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <Icon
      name={PANE_ICON[name] ?? "terminal"}
      size={size}
      strokeWidth={1.8}
      className={className}
    />
  );
}

/**
 * Which pane a phone shows and which tab the side panel is on, in the URL.
 *
 * They were state, and iOS evicts a backgrounded app often: coming back to a
 * session you had left on its diff reopened it on the terminal, every time.
 * `?side=changes` alone is also how the inbox links straight to a finished
 * run's diff — arriving at the terminal of a session that has none is a dead
 * end on a phone, where the sidebar is a tab rather than a column — so a side
 * with no pane named means the side.
 *
 * A hook of its own so the screen's compiler pass does not have to reason
 * about the `URLSearchParams` it reads, which it takes to be mutable and so
 * stops trusting every state setter declared after it.
 */
function useView() {
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const named = params.get("side");
  const side: Side = SIDES.some((s) => s.key === named) ? (named as Side) : "files";
  const pane: "tree" | "term" =
    params.get("pane") === "tree" || (params.get("pane") === null && named !== null)
      ? "tree"
      : "term";
  /**
   * Replaced rather than pushed: a tab is where you are on this screen, not a
   * place Back should step through. Written once any overlay closing with it
   * has dropped its own history entry — the phone's picker sheet closes on the
   * same tap, and a replace landing on the sheet's entry would take the marker
   * that tells it the entry is its own.
   */
  const show = (next: { pane?: "tree" | "term"; side?: Side }) => {
    const nextPane = next.pane ?? pane;
    const nextSide = next.side ?? side;
    void overlaysSettled().then(() =>
      setParams(
        (cur) => {
          const out = new URLSearchParams(cur);
          out.delete("pane");
          out.delete("side");
          if (nextPane === "tree" || nextSide !== "files") {
            out.set("pane", nextPane);
            out.set("side", nextSide);
          }
          return out;
        },
        { replace: true, state: location.state },
      ),
    );
  };
  return { pane, side, show };
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
  const { pane, side, show } = useView();
  const { data: session, notFound } = usePoll<SessionInfo>(`/api/sessions/${id}`);
  const {
    data: tree,
    error: treeError,
    refresh: refreshTree,
  } = usePoll<Tree>(
    session ? `/api/projects/${encodeURIComponent(session.project)}/tree` : null,
    8_000,
  );
  const {
    data: git,
    error: gitError,
    refresh: refreshGit,
  } = usePoll<GitStatus>(
    session ? `/api/projects/${encodeURIComponent(session.project)}/git` : null,
    8_000,
  );
  // The badge the top bar carried, which this screen no longer shows on a
  // phone — so the count has to reach the ⋯ that took the bar's place. The bar
  // keeps its own poll for every other screen; one extra GET every two minutes
  // on a desktop session is cheaper than a context for two call sites.
  const waiting = useNeedsYou();
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
    readStored(VIEW_KEY) === "chat" ? "chat" : "agent",
  );
  useEffect(() => writeStored(VIEW_KEY, main), [main]);
  const [full, setFull] = useState(false);
  // Sidebar width and the split ratio are per-device preferences that used to
  // reset on every navigation between sessions.
  const [sideWidth, setSideWidth] = useState(() => readStoredNumber(SIDE_KEY, 250, 160, 640));
  /**
   * Floor for the column. The PR and run panels came from a full-width screen;
   * at the 250px default every run row wrapped to four lines. Applied as a
   * minimum rather than a resize, so the stored width survives switching tabs.
   */
  const sideMin = side === "prs" || side === "runs" ? 340 : 160;
  const sideShown = Math.max(sideWidth, sideMin);

  useEffect(() => writeStored(SIDE_KEY, String(sideWidth)), [sideWidth]);

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
  const [ratio, setRatio] = useState(() => readStoredNumber(RATIO_KEY, 50, 20, 80));
  useEffect(() => writeStored(RATIO_KEY, String(ratio)), [ratio]);
  const splitBox = useRef<HTMLDivElement>(null);
  const viewer = useUrlOverlay(["file", "diff", "line"]);
  const { file: viewedPath, diff: viewedDiff, line: viewedLine } = viewer.values;
  const viewed: FileTarget | null = viewedPath
    ? {
        path: viewedPath,
        diff:
          viewedDiff === "work" || viewedDiff === "staged" || viewedDiff === "range"
            ? viewedDiff
            : undefined,
        line: Number(viewedLine) > 0 ? Number(viewedLine) : undefined,
      }
    : null;
  const openFile = (path: string, line?: number) =>
    viewer.show({ file: path, ...(line ? { line: String(line) } : {}) });
  const openDiff = (f: GitFileStatus) =>
    viewer.show({ file: f.path, diff: f.staged ? "staged" : "work" });
  /** One file's diff over the session's own commit range, not the working tree. */
  const openRangeDiff = (path: string) => viewer.show({ file: path, diff: "range" });
  const [confirm, confirmDialog] = useConfirm();
  // Kill and delete, which had no catch at all: over a tunnel that had dropped
  // the menu closed, the screen navigated away, and nothing said the pod had
  // not heard it.
  const { error: actError, run: act, clearError: clearActError } = useAction();

  async function uploadFile(f: File) {
    if (!session) return;
    // Through api(), which says when the pod is unreachable and does not wait
    // on a dropped tunnel for minutes; the minute is for the bytes themselves.
    await api(
      `/api/projects/${encodeURIComponent(session.project)}/file?path=${encodeURIComponent(f.name)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: f,
        timeoutMs: 60_000,
      },
    );
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
    // Leaving the screen is what says it worked, so it only happens when it
    // did. A DELETE that never reached the pod used to navigate away all the
    // same, and the session was still running when the list painted again.
    if (await act(() => api(`/api/sessions/${session.id}`, { method: "DELETE" }))) {
      void navigate(`/p/${encodeURIComponent(session.project)}`);
    }
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
    if (await act(() => api(`/api/sessions/${session.id}?purge=1`, { method: "DELETE" }))) {
      void navigate(`/p/${encodeURIComponent(session.project)}`);
    }
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

  // A session id the pod does not have used to sit on its skeletons for ever,
  // which is exactly what a push notification tapped after the session was
  // deleted or retired from history lands on.
  if (notFound) {
    return (
      <>
        <TopBar back="/" crumb={[{ label: "session" }]} />
        <main className="mx-auto max-w-[700px] px-[18px] pt-[22px]">
          <PageHeader
            icon="alert"
            label="Session"
            title="No such session"
            sub={
              <>
                <code className="font-mono text-[12.5px]">{id}</code> is not a session on the pod.
                It was deleted, or it is older than the history the pod keeps.
              </>
            }
          />
        </main>
      </>
    );
  }

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
          back={session ? `/p/${encodeURIComponent(session.project)}` : "/"}
          crumb={
            session
              ? [
                  { label: session.project, to: `/p/${encodeURIComponent(session.project)}` },
                  { label: session.title },
                ]
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
            on a phone: without it whatever is topmost lands under the status
            bar, where a tap does not reach the page at all. `max(10px, …)` is
            exactly the old pt-2.5 wherever there is no inset.

            No `kbd:` exception. The keyboard does not move the camera: with the
            row hidden it is the terminal's key bar that reaches the top, and at
            10px it sat under the Dynamic Island — eight keys that could be seen
            and not pressed. The inset costs rows the keyboard was going to take
            anyway; keys nobody can hit cost all of them. */}
        <main className="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col px-[18px] pt-[max(10px,env(safe-area-inset-top),var(--banner-h,0px))] pb-0 desk:pt-[18px] desk:pb-6">
          {/* Phone folds this row into the pane strip below: four stacked bars
              before the first terminal row left the agent a fifth of the
              screen. The title lives in the top bar crumb there instead. */}
          <div className="mb-2 hidden flex-none items-center gap-2 desk:mb-3.5 desk:flex desk:flex-wrap desk:gap-3">
            <StatusDot running={live} />
            <h1 className="min-w-0 truncate text-[14px] font-semibold desk:text-[16px]">
              {session ? (
                session.title
              ) : (
                <Skeleton className="inline-block h-4 w-48 rounded bg-surface-2 align-middle" />
              )}
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
                className="tap-sq flex flex-none items-center justify-center px-1 text-faint hover:text-text"
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          )}

          {/* Kill and delete are taken from a sheet that closes on the tap, so
              this is the only place their failure can be said. Announced: on a
              phone the sheet is what you were looking at, and the screen behind
              it is unchanged either way. */}
          {actError && (
            <Notice kind="fail" onDismiss={clearActError} className="mb-2 flex-none">
              {actError}
            </Notice>
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
          {/* Ruled and full-bleed, so the row reads as this screen's top bar
              rather than as three controls floating over the pane: it is the
              only screen without the real one, and it carries the bar's jobs —
              the way back, what you are looking at, and (in the sheet its ⋯
              opens) home, the inbox and its count, and settings. */}
          <div className="-mx-[18px] mb-2 flex flex-none items-center gap-2.5 border-b border-line px-[18px] pb-2.5 kbd:hidden desk:hidden">
            <BackButton to={session ? `/p/${encodeURIComponent(session.project)}` : "/"} />
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
            {/* The project, not the session. The top bar's crumb read
                `verksted / claude-15` and only one of the two survived the fold
                — the session's own name, which is the half you already know,
                since getting here meant picking it off a list. Which repo the
                agent is loose in is the thing worth having on screen, and the
                session name is the heading of the sheet the ⋯ opens.

                `flex-1` from a zero basis, so it is the slack in the row rather
                than a claim on it: the pane label keeps its own width and this
                takes whatever is left, down to nothing. */}
            <h1 className="min-w-0 flex-1 truncate text-[13.5px] text-muted">
              {session ? (
                session.project
              ) : (
                <Skeleton className="inline-block h-3.5 w-24 rounded bg-surface-2 align-middle" />
              )}
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
              <Splitter
                label="resize the sidebar"
                value={sideShown}
                min={sideMin}
                max={640}
                step={16}
                reset={Math.max(250, sideMin)}
                at={(x, el) => x - el.parentElement!.getBoundingClientRect().left}
                onChange={setSideWidth}
                className="absolute top-0 -right-2.5 bottom-0 z-10 hidden w-2 desk:block"
              />
              <SegTabs
                label="side panel"
                size="sm"
                value={side}
                onChange={(t) => show({ side: t })}
                items={SIDES.map(({ key: t }) => ({
                  value: t,
                  content: (
                    <>
                      <PaneIcon name={t} size={13} className={side === t ? "text-accent" : ""} />
                      {t}
                      {t === "git" && (git?.files.length ?? 0) > 0 && (
                        <span className="ml-1 text-wait">{git!.files.length}</span>
                      )}
                    </>
                  ),
                }))}
                // gap-2.5, not 1.5: these carry `tap-hit`, whose 44px overlay
                // has to meet its neighbour's inside the gap when the row wraps.
                className="mb-2 flex flex-none flex-wrap gap-2.5"
              />
              {side === "files" && (
                <PollError error={treeError} what="the files" retry={refreshTree} />
              )}
              {side === "git" && (
                <PollError error={gitError} what="git status" retry={refreshGit} />
              )}
              {side === "files" && (
                <FileTree
                  treeKey={session?.project ?? ""}
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
              // A dark island while it holds the terminal, which stays dark in
              // light mode; the conversation takes the page's own mode.
              className={`${chatView ? "" : "text-text scheme-dark "}${
                full
                  ? // The visual viewport spans the whole screen, notch and home
                    // indicator included, so full screen has to inset itself —
                    // otherwise the pane strip lands under the status bar and
                    // the terminal's last row under the home indicator.
                    //
                    // `kbd:pb-0` only. The keyboard covers the home indicator,
                    // so that inset reserves a band nothing is drawn under any
                    // more — but it does not cover the camera, and zeroing the
                    // top inset too put the key bar under the Dynamic Island,
                    // where it could be seen and not pressed.
                    "fixed inset-x-0 top-0 z-50 flex h-dvh flex-col overflow-hidden bg-term pt-[max(env(safe-area-inset-top),var(--banner-h,0px))] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] kbd:top-[var(--vvt,0px)] kbd:h-[var(--vvh,100dvh)] kbd:pb-0"
                  : // Square-bottomed and edge-to-edge on a phone, because it now
                    // ends where the screen does; the home-indicator inset is
                    // padding inside it, so its own background carries under the
                    // indicator and its last line stops above it. `kbd:pb-0`
                    // because that inset does not fall to zero when the keyboard
                    // covers the indicator, and the band it reserves is the
                    // conversation you are typing into.
                    `${pane === "term" ? "flex" : "hidden desk:flex"} min-h-0 flex-col overflow-hidden rounded-t-xl border border-b-0 border-line bg-term pb-[env(safe-area-inset-bottom)] kbd:pb-0 desk:rounded-xl desk:border-b desk:pb-0 desk:h-[calc(var(--vvh,100dvh)-200px)] desk:min-h-[380px]`
              }`}
            >
              {/* On a phone the pane strip above the box carries these controls,
                  so the row only costs rows there when it's the way out of full. */}
              <div
                className={`${full ? "flex" : "hidden desk:flex"} flex-none items-center gap-2.5 border-b border-line bg-surface px-3.5 py-[9px] font-mono text-[11.5px] text-faint`}
              >
                <span className="hidden text-muted desk:inline">
                  {chatView ? "chat" : "tmux"} ·{" "}
                  {session ? (
                    session.id
                  ) : (
                    <Skeleton className="inline-block h-2.5 w-24 rounded bg-surface-2 align-middle" />
                  )}
                </span>
                {/* Mobile: one pane at a time, these switch between them. Kept
                    for full screen, which hides the strip above the box. */}
                <span role="group" aria-label="pane" className="flex gap-1.5 desk:hidden">
                  {views.map((v) => (
                    <button
                      key={v}
                      aria-pressed={viewOn(v)}
                      onClick={() => pickView(v)}
                      className={`flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 ${
                        viewOn(v)
                          ? "border-accent bg-surface-2 text-text"
                          : "border-line text-muted"
                      }`}
                    >
                      <PaneIcon name={v} size={13} />
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
                          className={`flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${
                            chatView === (v === "chat")
                              ? "border-accent bg-surface-2 text-text"
                              : "border-line text-muted"
                          }`}
                        >
                          <PaneIcon name={v} size={13} />
                          {v === "chat" ? "chat" : "terminal"}
                        </button>
                      ))}
                    </span>
                  )}
                  {live && (
                    <span className="hidden gap-2 desk:flex">
                      <button
                        onClick={() => setShell((s) => !s)}
                        aria-pressed={shell}
                        className={`flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${shell ? "border-accent text-text" : "border-line"}`}
                      >
                        {shell ? (
                          <Icon name="close" size={12} />
                        ) : (
                          <PaneIcon name="shell" size={13} />
                        )}
                        shell
                      </button>
                      <button
                        onClick={() => setBrowser((b) => !b)}
                        aria-pressed={browser}
                        className={`flex items-center gap-1.5 rounded-[5px] border px-2 py-0.5 hover:border-faint hover:text-text ${browser ? "border-accent text-text" : "border-line"}`}
                      >
                        {browser ? (
                          <Icon name="close" size={12} />
                        ) : (
                          <PaneIcon name="browser" size={13} />
                        )}
                        browser
                      </button>
                    </span>
                  )}
                  <button
                    onClick={() => setFull((f) => !f)}
                    aria-pressed={full}
                    className="flex items-center gap-1.5 rounded-[5px] border border-line px-2 py-0.5 hover:border-faint hover:text-text"
                  >
                    <Icon name={full ? "shrink" : "expand"} size={12} />
                    full
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
                      <ChatPane session={session} onOpenTerminal={() => setMain("agent")} />
                    ) : live ? (
                      <Terminal sessionId={session.id} project={session.project} />
                    ) : (
                      <div className="flex flex-1 items-center justify-center font-mono text-[13px] text-faint">
                        session ended {session.endedAt ? agoLabel(session.endedAt) : ""}
                      </div>
                    )}
                  </div>
                  {(shell || browser) && (
                    <Splitter
                      label="resize the agent pane"
                      value={ratio}
                      min={20}
                      max={80}
                      step={2}
                      reset={50}
                      at={(x) => {
                        const box = splitBox.current!.getBoundingClientRect();
                        return ((x - box.left) / box.width) * 100;
                      }}
                      onChange={setRatio}
                      className="hidden w-1.5 flex-none bg-line desk:block"
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
                      <BrowserPane wsPath={`/api/sessions/${session.id}/browser`} />
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
                go: () => show({ pane: "tree", side: sd.key }),
              })),
              ...views.map((v) => ({
                key: v,
                label: viewLabel(v),
                hint: viewHint(v),
                on: pane === "term" && viewOn(v),
                go: () => {
                  show({ pane: "term" });
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
            <Button
              onClick={() => {
                setMenu(false);
                setFull(true);
              }}
              size="lg"
              className="w-full"
            >
              ⛶ full screen
            </Button>
            <Link
              to="/"
              aria-label="verksted — home"
              className={buttonClass("ghost", "lg", "w-full")}
            >
              verksted — home
            </Link>
            <Link to="/runs" className={buttonClass("ghost", "lg", "w-full")}>
              inbox{waiting ? ` · ${waiting} waiting` : ""}
            </Link>
            <Link to="/settings" className={buttonClass("ghost", "lg", "w-full")}>
              settings
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            {live && (
              <Button
                onClick={() => {
                  setMenu(false);
                  void kill();
                }}
                variant="ghost-danger"
                size="lg"
                className="w-full"
              >
                kill session
              </Button>
            )}
            <Button
              onClick={() => {
                setMenu(false);
                void deleteSession();
              }}
              variant="ghost-danger"
              size="lg"
              className="w-full"
            >
              delete session
            </Button>
          </div>
        </Sheet>
      )}

      {session && (
        <FileViewer
          project={session.project}
          sessionId={session.id}
          target={viewed}
          onClose={viewer.hide}
        />
      )}
      {confirmDialog}
    </>
  );
}
