import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { UploadedFile } from "../../../shared/api";

// Agent sign-in URLs (claude/codex/antigravity oauth + device flows). Selecting
// and copying these off a phone terminal is painful; we surface a tap target.
const AUTH_URL_RE = /https?:\/\/[^\s]*(?:oauth|authorize|login|signin|sign-in|verify|\/device)[^\s]*/i;

// A wrapped URL continuation row is one unbroken run of URL characters — no
// spaces, since that's the only thing wrapping split. This is the reconnection
// signal, and unlike "row is full" it never depends on the wrap width matching
// the terminal's current cols (which a keyboard-driven resize can desync).
const URL_CHARS_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/**
 * Most recent auth URL visible in the terminal, or null. Only the last ~400
 * rows are scanned — the sign-in URL is always the freshest thing on screen.
 *
 * A long URL is split across rows by xterm's wrapping or by the agent TUI
 * hard-wrapping. We find the row the URL starts on, then — only if it ran to
 * that row's end — keep appending following rows while each is a pure run of
 * URL characters. The first row that isn't (a blank line, prose, a prompt)
 * ends it. No reference to cols, so a resize between render and scan can't
 * truncate the result.
 */
function findAuthUrl(term: Xterm): string | null {
  const buf = term.buffer.active;
  const start = Math.max(0, buf.length - 400);
  const rows: string[] = [];
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    rows.push(line ? line.translateToString(true) : ""); // right-trimmed
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i].match(AUTH_URL_RE);
    if (!m) continue;
    let url = m[0];
    // Continuation rows exist only if the URL reached this row's end.
    if (rows[i].indexOf(m[0]) + m[0].length === rows[i].length) {
      for (let j = i + 1; j < rows.length && URL_CHARS_RE.test(rows[j]); j++) {
        url += rows[j];
      }
    }
    return url;
  }
  return null;
}

// shift+tab: claude's permission-mode toggle.
const MODE_SEQ = "\x1b[Z";

/**
 * The permission mode as the agent prints it on its status line — the row the
 * on-screen keyboard covers, which is the whole reason for the chip.
 *
 * claude renders that line as `<symbol> <indicator> on`; the indicators below
 * are its full set, read off the CLI bundle rather than guessed. An unknown
 * one just leaves the chip reading "mode", same as before it could detect any.
 */
const MODES: { re: RegExp; label: string; tone: string }[] = [
  { re: /bypass permissions on\b/i, label: "bypass", tone: "border-fail text-fail" },
  { re: /don['’]t ask on\b/i, label: "don't ask", tone: "border-fail text-fail" },
  { re: /accept edits on\b/i, label: "accept edits", tone: "border-run text-run" },
  { re: /auto mode on\b/i, label: "auto", tone: "border-run text-run" },
  { re: /plan mode on\b/i, label: "plan", tone: "border-accent text-accent" },
  { re: /manual mode on\b/i, label: "manual", tone: "border-line text-muted" },
];

/**
 * Permission mode currently shown on the terminal's status line, or null when
 * no line matches. Only the viewport is scanned — never the scrollback, where a
 * stale mode line from an earlier screen would win.
 */
function findMode(term: Xterm): (typeof MODES)[number] | null {
  const buf = term.buffer.active;
  for (let i = buf.baseY + term.rows - 1; i >= buf.baseY; i--) {
    const line = buf.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    const hit = MODES.find((m) => m.re.test(text));
    if (hit) return hit;
  }
  return null;
}

/** Special keys for touch screens, where the on-screen keyboard lacks them. */
const KEYS: { label: string; seq: string }[] = [
  { label: "esc", seq: "\x1b" },
  // carriage return — submits the claude prompt / a pasted sign-in code
  { label: "enter", seq: "\r" },
  { label: "/", seq: "/" },
  { label: "tab", seq: "\t" },
  { label: "^C", seq: "\x03" },
  { label: "↑", seq: "\x1b[A" },
  { label: "↓", seq: "\x1b[B" },
  { label: "←", seq: "\x1b[D" },
  { label: "→", seq: "\x1b[C" },
];

// Toolbar key styling. Tap feedback matters more here than it looks: on a phone
// these keys are the whole keyboard, and a press that leaves no mark reads as a
// press that didn't land. :active covers the finger-down moment; `flash` holds
// the same look for a moment after release, which is what makes a quick tap
// visible at all.
const KEY = "flex-none rounded-md border px-2.5 py-1 font-mono text-[12px] transition-colors";
const KEY_PRESS = "active:border-accent active:bg-accent/25 active:text-accent";
const KEY_IDLE = "border-line text-muted";
const KEY_LIT = "border-accent bg-accent/25 text-accent";

/** How long a key keeps the pressed look after the finger lifts. */
const FLASH_MS = 160;

export default function Terminal({
  sessionId,
  project,
  shell = false,
}: {
  sessionId: string;
  /** Project the session runs in — the upload target for the image button. */
  project: string;
  /** Attach the session's companion shell instead of the agent tmux session. */
  shell?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Xterm | null>(null);
  // Sticky Ctrl: the next typed letter is sent as its control code.
  const ctrlArmed = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Consecutive failed reconnects (the backoff), and whether the server told us
  // the session is gone — in which case retrying is pointless.
  const retries = useRef(0);
  const [ended, setEnded] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number] | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [upload, setUpload] = useState<"idle" | "busy" | "failed">("idle");
  // Which toolbar key is showing the just-pressed look, and whether the pane is
  // scrolled back into its history (tmux copy mode).
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  const [scrolled, setScrolled] = useState(false);
  const pendingScroll = useRef(0);
  const scrollTimer = useRef<number | undefined>(undefined);

  function sendInput(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
    // Typing returns to the live view — the server drops copy mode on input.
    // A scroll still queued from the gesture before it would drag the view
    // straight back off the prompt, so it goes too.
    pendingScroll.current = 0;
    setScrolled(false);
  }

  /**
   * Scroll the session's history by `lines` (positive goes back). Which history
   * that is depends on the pane: a full-screen TUI that turned mouse reporting
   * on (claude) keeps its conversation in its own buffer and scrolls itself,
   * while tmux's scrollback holds nothing but the line that started it — so
   * that pane gets the gesture as wheel notches, three lines each, the way a
   * real terminal reports them. Any position inside the pane does; the app
   * scrolls its transcript, not a region under the pointer. A plain shell
   * reports no mouse, and for it tmux's own history is the scrollback.
   *
   * Deltas are batched into one message per tick — a single drag fires dozens
   * of touchmove events and each server-side scroll is a tmux call. Fractions
   * carry over between ticks so a slow drag still moves.
   */
  function scrollBy(lines: number) {
    pendingScroll.current += lines;
    if (scrollTimer.current !== undefined) return;
    scrollTimer.current = window.setTimeout(() => {
      scrollTimer.current = undefined;
      const ws = wsRef.current;
      const term = termRef.current;
      if (!term || ws?.readyState !== WebSocket.OPEN) return;
      if (term.modes.mouseTrackingMode !== "none") {
        const notches = Math.trunc(pendingScroll.current / 3);
        if (notches === 0) return;
        pendingScroll.current -= notches * 3;
        const wheel = `\x1b[<${notches > 0 ? 64 : 65};${Math.ceil(term.cols / 2)};${Math.ceil(term.rows / 2)}M`;
        ws.send(JSON.stringify({ t: "in", data: wheel.repeat(Math.abs(notches)) }));
        return;
      }
      const whole = Math.trunc(pendingScroll.current);
      pendingScroll.current -= whole;
      if (whole === 0) return;
      ws.send(JSON.stringify({ t: "scroll", lines: whole }));
      if (whole > 0) setScrolled(true);
    }, 50);
  }

  // An empty input frame leaves copy mode without typing anything into the
  // session — the same path any keystroke takes back to the live view.
  function goLive() {
    sendInput("");
  }

  function press(id: string) {
    setFlash(id);
    clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  }

  // Touch-toolbar taps run on click — the dependable tap event on iOS, where
  // onPointerDown+preventDefault can silently swallow the tap — then refocus
  // the terminal (in the same gesture) so the on-screen keyboard stays up.
  function tapKey(id: string, run: () => void) {
    run();
    press(id);
    termRef.current?.focus();
  }

  /** Class list for a toolbar key: idle look unless pressed or already lit. */
  function keyClass(id: string, base = KEY_IDLE) {
    return `${KEY} ${KEY_PRESS} ${flash === id ? KEY_LIT : base}`;
  }

  // Pasting into an xterm terminal is awkward on a phone (no paste affordance on
  // the on-screen keyboard); send the clipboard straight in instead.
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
    } catch {
      // clipboard read denied — nothing we can do without the OS prompt
    }
  }

  // A phone has no clipboard route for screenshots, so the picker (photo
  // library / camera) stands in for pasting: upload the images, then type their
  // paths into the prompt so the agent can read them. No Enter — the user writes
  // the rest of the message around them. One request per image, in the order
  // they were picked; whatever landed gets typed even if a later one fails.
  async function sendImages(files: File[]) {
    setUpload("busy");
    const paths: string[] = [];
    let failed = false;
    for (const f of files) {
      try {
        const res = await fetch(
          `/api/projects/${encodeURIComponent(project)}/upload?filename=${encodeURIComponent(f.name)}`,
          { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f },
        );
        if (!res.ok) throw new Error(String(res.status));
        const { path } = (await res.json()) as UploadedFile;
        paths.push(path);
      } catch {
        failed = true;
      }
    }
    if (paths.length) sendInput(`${paths.join(" ")} `);
    setUpload(failed ? "failed" : "idle");
    // Bring the on-screen keyboard back; the picker took the focus away.
    if (!failed) termRef.current?.focus();
  }

  async function copyAuthUrl() {
    if (!authUrl) return;
    try {
      await navigator.clipboard.writeText(authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked (rare over https) — the open link still works
    }
  }

  // Send the auth code the sign-in redirect handed back, plus Enter. A native
  // input field is where a phone can actually paste; the terminal can't.
  function sendCode() {
    const trimmed = code.trim();
    if (!trimmed) return;
    sendInput(trimmed + "\r");
    setCode("");
    setAuthUrl(null);
    setCopied(false);
  }

  useEffect(() => {
    const el = ref.current!;
    const term = new Xterm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace',
      theme: {
        background: "#0b0e12",
        foreground: "#e7eaf0",
        cursor: "#e7eaf0",
        selectionBackground: "#2a3140",
        // ANSI 16 tuned to the app palette; stock xterm colors clash.
        black: "#22262e",
        red: "#e5646a",
        green: "#4ec97b",
        yellow: "#d9a441",
        blue: "#7aa2f7",
        magenta: "#c678dd",
        cyan: "#56b6c2",
        white: "#a8b1c2",
        brightBlack: "#566072",
        brightRed: "#ef7a80",
        brightGreen: "#66d992",
        brightYellow: "#e8b55e",
        brightBlue: "#8fb3ff",
        brightMagenta: "#d48ce8",
        brightCyan: "#6cc9d5",
        brightWhite: "#e7eaf0",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    termRef.current = term;

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/api/sessions/${sessionId}/attach?cols=${term.cols}&rows=${term.rows}${shell ? "&shell=1" : ""}`,
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    let unmounted = false;

    let scanTimer: number | undefined;
    setMode(null);
    setEnded(false);
    ws.onopen = () => {
      setDisconnected(false);
      retries.current = 0;
    };
    ws.onmessage = (e) => {
      term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
      // Debounced so we scan settled output, not every partial frame.
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(() => {
        const url = findAuthUrl(term);
        if (url) setAuthUrl(url);
        // Sticky: while the agent works it replaces the status line with its
        // own hints, and the mode hasn't changed just because it scrolled off.
        const m = findMode(term);
        if (m) setMode(m);
      }, 400);
    };
    ws.onclose = (e) => {
      // 4404 is the attach route saying the session no longer exists (ended or
      // purged); no amount of reconnecting brings it back.
      if (!unmounted) {
        if (e.code === 4404) setEnded(true);
        setDisconnected(true);
      }
    };

    // One text row in CSS pixels — fit() sizes rows to this box, so the box
    // height over the row count is the row height.
    const rowHeight = () => Math.max(1, el.clientHeight / term.rows);

    // Wheel and trackpad. Returning false stops xterm's own handling, which in
    // the alternate screen is the ↑/↓ conversion we are replacing — unless the
    // app asked for mouse events, in which case xterm already sends it exactly
    // the wheel report it is waiting for.
    term.attachCustomWheelEventHandler((ev) => {
      if (term.modes.mouseTrackingMode !== "none") return true;
      const rows =
        ev.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? ev.deltaY
          : ev.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? ev.deltaY * term.rows
            : ev.deltaY / rowHeight();
      scrollBy(-rows);
      return false;
    });

    // Touch drag: the content follows the finger, as in any scroll view.
    let dragY = 0;
    let dragging = false;
    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      dragY = e.touches[0].clientY;
      dragging = false;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - dragY;
      // Under the threshold this is still a tap (focus, keyboard), not a drag.
      if (!dragging && Math.abs(dy) < 8) return;
      dragging = true;
      dragY = e.touches[0].clientY;
      // Keeps the drag from becoming a text selection or a page pan.
      e.preventDefault();
      scrollBy(dy / rowHeight());
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });

    const input = term.onData((data) => {
      pendingScroll.current = 0;
      setScrolled(false);
      if (ctrlArmed.current && /^[a-zA-Z]$/.test(data)) {
        ctrlArmed.current = false;
        setCtrl(false);
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64);
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
    });

    let debounce: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        fit.fit();
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ t: "resize", cols: term.cols, rows: term.rows }));
        }
      }, 100);
    });
    ro.observe(el);

    return () => {
      unmounted = true;
      clearTimeout(debounce);
      clearTimeout(scanTimer);
      clearTimeout(scrollTimer.current);
      clearTimeout(flashTimer.current);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, shell, attempt]);

  // Keep retrying while the pane is on screen (tmux repaints on re-attach), 1s
  // doubling to 30s so a pod that is down isn't hammered. Waiting for a
  // visibilitychange instead is not enough: iOS suspends the socket the moment
  // the app is backgrounded, and on resume the close event lands *after* that
  // event has fired — so the pane would sit under a dead overlay until tapped.
  // While hidden there is nothing to reconnect for; the tap still works.
  useEffect(() => {
    if (!disconnected || ended) return;
    if (document.hidden) {
      const onVisible = () => {
        if (!document.hidden) setAttempt((a) => a + 1);
      };
      document.addEventListener("visibilitychange", onVisible);
      return () => document.removeEventListener("visibilitychange", onVisible);
    }
    const id = setTimeout(
      () => {
        retries.current += 1;
        setAttempt((a) => a + 1);
      },
      Math.min(30_000, 1000 * 2 ** retries.current),
    );
    return () => clearTimeout(id);
  }, [disconnected, attempt, ended]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Above the terminal, not below: on a phone the on-screen keyboard
          overlays the bottom of the box and would hide a bottom key row. */}
      <div className="hidden flex-none gap-1 overflow-x-auto border-b border-line bg-surface px-1.5 py-1 pointer-coarse:flex">
        {/* First in the row so it survives the overflow scroll: this doubles as
            the readout for a status line the keyboard covers. */}
        <button
          onClick={() => tapKey("mode", () => sendInput(MODE_SEQ))}
          title="cycle permission mode (shift+tab)"
          className={keyClass("mode", mode ? mode.tone : KEY_IDLE)}
        >
          {mode?.label ?? "mode"}
        </button>
        <button
          onClick={() =>
            tapKey("ctrl", () => {
              ctrlArmed.current = !ctrlArmed.current;
              setCtrl(ctrlArmed.current);
            })
          }
          className={keyClass("ctrl", ctrl ? KEY_LIT : KEY_IDLE)}
        >
          ctrl
        </button>
        <button onClick={() => tapKey("paste", pasteFromClipboard)} className={keyClass("paste")}>
          paste
        </button>
        <button
          onClick={() => {
            press("img");
            picker.current?.click();
          }}
          disabled={upload === "busy"}
          className={keyClass("img", upload === "failed" ? "border-wait text-wait" : KEY_IDLE)}
        >
          {upload === "busy" ? "…" : upload === "failed" ? "img ✕" : "img"}
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = "";
            if (files.length) void sendImages(files);
          }}
        />
        {KEYS.map((k) => (
          <button
            key={k.label}
            onClick={() => tapKey(k.label, () => sendInput(k.seq))}
            className={keyClass(k.label)}
          >
            {k.label}
          </button>
        ))}
        {/* A page of history at a time — the same scrollback the drag gesture
            moves, not the PgUp/PgDn keys the agent would swallow. */}
        <button
          onClick={() => tapKey("pgup", () => scrollBy((termRef.current?.rows ?? 24) - 2))}
          title="scroll back"
          className={keyClass("pgup")}
        >
          ⇞
        </button>
        <button
          onClick={() => tapKey("pgdn", () => scrollBy(-((termRef.current?.rows ?? 24) - 2)))}
          title="scroll forward"
          className={keyClass("pgdn")}
        >
          ⇟
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={ref} className="absolute inset-0 p-2" />
        {scrolled && !disconnected && (
          <button
            onClick={() => tapKey("live", goLive)}
            className={`absolute right-3 bottom-3 z-10 rounded-full border bg-surface/90 px-3 py-1.5 font-mono text-[12px] shadow-lg transition-colors ${
              flash === "live" ? KEY_LIT : "border-accent text-accent"
            }`}
          >
            ↓ live
          </button>
        )}
        {/* Two different situations behind one overlay before: a backend that
            will come back (retrying works, and does so on its own) and a
            session that is gone for good (retrying can only fail). Say which. */}
        {disconnected && (
          <button
            onClick={() => setAttempt((a) => a + 1)}
            className="absolute inset-0 z-10 flex items-center justify-center px-6 text-center bg-term/80 font-mono text-[13px] text-muted"
          >
            {ended
              ? "this session has ended — start a new one with “resume” to pick the conversation up"
              : "reconnecting — tap to retry now"}
          </button>
        )}
      </div>
      {authUrl && (
        <div className="flex flex-none flex-col gap-1.5 border-t border-line bg-surface px-2 py-1.5 font-mono text-[12px]">
          <div className="flex items-center gap-2">
            <span className="flex-none text-muted">sign-in link</span>
            <span className="min-w-0 flex-1 truncate text-muted/60">{authUrl}</span>
            <a
              href={authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex-none rounded-md border border-accent px-2 py-0.5 text-accent active:bg-surface-2"
            >
              open ↗
            </a>
            <button
              onClick={copyAuthUrl}
              className="flex-none rounded-md border border-line px-2 py-0.5 text-muted active:bg-surface-2"
            >
              {copied ? "copied" : "copy"}
            </button>
            <button
              onClick={() => {
                setAuthUrl(null);
                setCopied(false);
              }}
              className="flex-none rounded-md px-1.5 py-0.5 text-muted active:bg-surface-2"
              aria-label="dismiss sign-in link"
            >
              ✕
            </button>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendCode();
            }}
            className="flex items-center gap-2"
          >
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="paste the code here, then Send"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="send"
              className="min-w-0 flex-1 rounded-md border border-line bg-term px-2 py-1 text-text placeholder:text-muted/50 focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              className="flex-none rounded-md border border-accent px-3 py-1 text-accent active:bg-surface-2"
            >
              send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
