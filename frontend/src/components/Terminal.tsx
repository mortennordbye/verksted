import { useEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

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

  function sendInput(data: string) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
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

    ws.onopen = () => setDisconnected(false);
    ws.onmessage = (e) =>
      term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
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
