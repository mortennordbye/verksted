import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

// Agent sign-in URLs (claude/codex/antigravity oauth + device flows). Selecting
// and copying these off a phone terminal is painful; we surface a tap target.
const AUTH_URL_RE = /https?:\/\/[^\s]*(?:oauth|authorize|login|signin|sign-in|verify|\/device)[^\s]*/i;

/**
 * Most recent auth URL visible in the terminal, or null. Only the last ~400
 * rows are scanned — the sign-in URL is always the freshest thing on screen.
 *
 * A long URL is split across rows either by xterm's own wrapping or by the
 * agent TUI hard-wrapping to the terminal width. Both cases share one tell:
 * the row before a continuation is completely full (reaches the last column).
 * So we join a row to the previous one whenever that previous row was full,
 * and only insert a boundary after a row that ended short — which reassembles
 * the URL regardless of who wrapped it. URLs contain no spaces, so the join
 * never merges an auth URL with adjacent prose.
 */
function findAuthUrl(term: Xterm): string | null {
  const buf = term.buffer.active;
  const cols = term.cols;
  const start = Math.max(0, buf.length - 400);
  let text = "";
  for (let i = start; i < buf.length; i++) {
    const line = buf.getLine(i);
    if (!line) continue;
    const row = line.translateToString(true); // right-trimmed
    text += row;
    if (row.length < cols) text += "\n"; // row ended short — not a wrap point
  }
  const matches = text.match(new RegExp(AUTH_URL_RE.source, "gi"));
  return matches ? matches[matches.length - 1] : null;
}

/** Special keys for touch screens, where the on-screen keyboard lacks them. */
const KEYS: { label: string; seq: string }[] = [
  { label: "esc", seq: "\x1b" },
  { label: "/", seq: "/" },
  // shift+tab: claude's permission-mode toggle
  { label: "mode", seq: "\x1b[Z" },
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
  shell = false,
}: {
  sessionId: string;
  /** Attach the session's companion shell instead of the agent tmux session. */
  shell?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Sticky Ctrl: the next typed letter is sent as its control code.
  const ctrlArmed = useRef(false);
  const [ctrl, setCtrl] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [code, setCode] = useState("");

  function sendInput(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
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

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(
      `${proto}://${location.host}/api/sessions/${sessionId}/attach?cols=${term.cols}&rows=${term.rows}${shell ? "&shell=1" : ""}`,
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    let unmounted = false;

    let scanTimer: number | undefined;
    ws.onopen = () => setDisconnected(false);
    ws.onmessage = (e) => {
      term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
      // Debounced so we scan settled output, not every partial frame.
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(() => {
        const url = findAuthUrl(term);
        if (url) setAuthUrl(url);
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
              onPointerDown={(e) => {
                e.preventDefault();
                copyAuthUrl();
              }}
              className="flex-none rounded-md border border-line px-2 py-0.5 text-muted active:bg-surface-2"
            >
              {copied ? "copied" : "copy"}
            </button>
            <button
              onPointerDown={(e) => {
                e.preventDefault();
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
      <div className="hidden flex-none gap-1 overflow-x-auto border-t border-line bg-surface px-1.5 py-1 pointer-coarse:flex">
        <button
          // pointerdown + preventDefault so the on-screen keyboard stays up
          onPointerDown={(e) => {
            e.preventDefault();
            ctrlArmed.current = !ctrlArmed.current;
            setCtrl(ctrlArmed.current);
          }}
          className={`rounded-md border px-2.5 py-1 font-mono text-[12px] ${
            ctrl ? "border-accent bg-surface-2 text-accent" : "border-line text-muted"
          }`}
        >
          ctrl
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            pasteFromClipboard();
          }}
          className="rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted active:bg-surface-2"
        >
          paste
        </button>
        {KEYS.map((k) => (
          <button
            key={k.label}
            onPointerDown={(e) => {
              e.preventDefault();
              sendInput(k.seq);
            }}
            className="rounded-md border border-line px-2.5 py-1 font-mono text-[12px] text-muted active:bg-surface-2"
          >
            {k.label}
          </button>
        ))}
      </div>
    </div>
  );
}
