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
  // tmux scrollback (claude's own hint: "scroll with PgUp/PgDn")
  { label: "⇞", seq: "\x1b[5~" },
  { label: "⇟", seq: "\x1b[6~" },
];

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
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<(typeof MODES)[number] | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");
  const [upload, setUpload] = useState<"idle" | "busy" | "failed">("idle");

  function sendInput(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
  }

  // Touch-toolbar taps run on click — the dependable tap event on iOS, where
  // onPointerDown+preventDefault can silently swallow the tap — then refocus
  // the terminal (in the same gesture) so the on-screen keyboard stays up.
  function tapKey(run: () => void) {
    run();
    termRef.current?.focus();
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
  // library / camera) stands in for pasting: upload the image, then type its
  // path into the prompt so the agent can read it. No Enter — the user writes
  // the rest of the message around it.
  async function sendImage(f: File) {
    setUpload("busy");
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/upload?filename=${encodeURIComponent(f.name)}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f },
      );
      if (!res.ok) throw new Error(String(res.status));
      const { path } = (await res.json()) as UploadedFile;
      sendInput(`${path} `);
      setUpload("idle");
      // Bring the on-screen keyboard back; the picker took the focus away.
      termRef.current?.focus();
    } catch {
      setUpload("failed");
    }
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
    ws.onopen = () => setDisconnected(false);
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
    ws.onclose = () => {
      if (!unmounted) setDisconnected(true);
    };

    const input = term.onData((data) => {
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
      ro.disconnect();
      input.dispose();
      ws.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, shell, attempt]);

  // One automatic retry (tmux repaints on re-attach); after that, reconnect
  // whenever the tab regains focus — coming back after minutes away should
  // just show the session again, not a dead overlay. Manual tap still works.
  useEffect(() => {
    if (!disconnected) return;
    if (attempt === 0) {
      const id = setTimeout(() => setAttempt(1), 1000);
      return () => clearTimeout(id);
    }
    const onVisible = () => {
      if (!document.hidden) setAttempt((a) => a + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [disconnected, attempt]);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* Above the terminal, not below: on a phone the on-screen keyboard
          overlays the bottom of the box and would hide a bottom key row. */}
      <div className="hidden flex-none gap-1 overflow-x-auto border-b border-line bg-surface px-1.5 py-1 pointer-coarse:flex">
        {/* First in the row so it survives the overflow scroll: this doubles as
            the readout for a status line the keyboard covers. */}
        <button
          onClick={() => tapKey(() => sendInput(MODE_SEQ))}
          title="cycle permission mode (shift+tab)"
          className={`flex-none rounded-md border px-2.5 py-1 font-mono text-[12px] active:bg-surface-2 ${
            mode ? mode.tone : "border-line text-muted"
          }`}
        >
          {mode?.label ?? "mode"}
        </button>
        <button
          onClick={() =>
            tapKey(() => {
              ctrlArmed.current = !ctrlArmed.current;
              setCtrl(ctrlArmed.current);
            })
          }
          className={`rounded-md border px-2.5 py-1 font-mono text-[12px] ${
            ctrl ? "border-accent bg-surface-2 text-accent" : "border-line text-muted"
          }`}
        >
          ctrl
        </button>
        <button
          onClick={() => tapKey(pasteFromClipboard)}
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted active:bg-surface-2"
        >
          paste
        </button>
        <button
          onClick={() => picker.current?.click()}
          disabled={upload === "busy"}
          className={`rounded-md border px-2.5 py-1 font-mono text-[12px] active:bg-surface-2 ${
            upload === "failed" ? "border-wait text-wait" : "border-line text-muted"
          }`}
        >
          {upload === "busy" ? "…" : upload === "failed" ? "img ✕" : "img"}
        </button>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void sendImage(f);
          }}
        />
        {KEYS.map((k) => (
          <button
            key={k.label}
            onClick={() => tapKey(() => sendInput(k.seq))}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted active:bg-surface-2"
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={ref} className="absolute inset-0 p-2" />
        {disconnected && (
          <button
            onClick={() => setAttempt((a) => a + 1)}
            className="absolute inset-0 z-10 flex items-center justify-center bg-term/80 font-mono text-[13px] text-muted"
          >
            disconnected — tap to reconnect
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
