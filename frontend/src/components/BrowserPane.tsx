import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
} from "react";
import type { BrowserClientMsg, BrowserServerMsg, ListeningPort } from "../../../shared/api";
import { api } from "../api";

// The on-screen keyboard relay keeps a sentinel in the hidden input so
// Backspace always changes the value (and therefore always fires oninput).
const SENTINEL = "​​​​";

// CDP Input modifier bits.
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

export default function BrowserPane({ sessionId }: { sessionId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // Remote viewport size from the last frame, for pointer coordinate mapping.
  const remote = useRef({ w: 1280, h: 800 });
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [url, setUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const editingRef = useRef(false);
  const [cdpUrl, setCdpUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const hiddenInput = useRef<HTMLInputElement>(null);
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);

  /** Relay a full key press (down+up) into the remote page. */
  function pressKey(key: string, keyCode: number, text?: string) {
    send({ t: "key", type: "keyDown", key, code: key, keyCode, text });
    send({ t: "key", type: "keyUp", key, code: key, keyCode });
  }

  function send(msg: BrowserClientMsg) {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${sessionId}/browser`);
    wsRef.current = ws;
    let unmounted = false;

    ws.onopen = () => setDisconnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as BrowserServerMsg;
      if (msg.t === "frame") {
        remote.current = { w: msg.w, h: msg.h };
        const img = new Image();
        img.onload = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          canvas.getContext("2d")!.drawImage(img, 0, 0);
        };
        img.src = `data:image/jpeg;base64,${msg.data}`;
      } else if (msg.t === "url") {
        setError(null);
        if (!editingRef.current) setUrl(msg.url === "about:blank" ? "" : msg.url);
      } else if (msg.t === "init") {
        setCdpUrl(msg.cdpUrl);
        if (!editingRef.current) setUrl(msg.url === "about:blank" ? "" : msg.url);
      } else if (msg.t === "error") {
        setError(msg.message);
      }
    };
    ws.onclose = () => {
      if (!unmounted) setDisconnected(true);
    };

    const box = boxRef.current!;
    let debounce: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        send({
          t: "resize",
          width: Math.round(box.clientWidth),
          height: Math.round(box.clientHeight),
        });
      }, 150);
    });
    ro.observe(box);

    return () => {
      unmounted = true;
      clearTimeout(debounce);
      ro.disconnect();
      ws.close();
      wsRef.current = null;
    };
  }, [sessionId, attempt]);

  // Reconnect on tab refocus after a drop, same pattern as the terminal.
  useEffect(() => {
    if (!disconnected) return;
    const onVisible = () => {
      if (!document.hidden) setAttempt((a) => a + 1);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [disconnected]);

  /** Canvas CSS coords -> remote viewport coords. */
  function toRemote(e: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * remote.current.w),
      y: Math.round(((e.clientY - rect.top) / rect.height) * remote.current.h),
    };
  }

  function mouse(
    e: RMouseEvent<HTMLCanvasElement>,
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
  ) {
    e.preventDefault();
    send({
      t: "mouse",
      type,
      ...toRemote(e),
      button: type === "mouseMoved" ? "none" : (BUTTONS[e.button] ?? "left"),
      clickCount: type === "mouseMoved" ? 0 : 1,
      modifiers: modifiers(e),
    });
  }

  function key(e: RKeyboardEvent<HTMLCanvasElement>, type: "keyDown" | "keyUp") {
    e.preventDefault();
    const text =
      type === "keyDown" && !e.ctrlKey && !e.metaKey
        ? e.key.length === 1
          ? e.key
          : e.key === "Enter"
            ? "\r"
            : undefined
        : undefined;
    send({
      t: "key",
      type,
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      text,
      modifiers: modifiers(e),
    });
  }

  const navBtn =
    "rounded-[5px] border border-line px-2 py-0.5 text-muted hover:border-faint hover:text-text";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5 font-mono text-[11.5px]">
        <button
          onClick={() => send({ t: "back" })}
          title="back"
          className={`${navBtn} hidden min-[800px]:block`}
        >
          ←
        </button>
        <button
          onClick={() => send({ t: "forward" })}
          title="forward"
          className={`${navBtn} hidden min-[800px]:block`}
        >
          →
        </button>
        <button onClick={() => send({ t: "reload" })} title="reload" className={navBtn}>
          ⟳
        </button>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onFocus={() => {
            setEditing(true);
            editingRef.current = true;
          }}
          onBlur={() => {
            setEditing(false);
            editingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && url.trim()) {
              send({ t: "nav", url: url.trim() });
              e.currentTarget.blur();
            }
          }}
          placeholder="url (e.g. localhost:5173)"
          spellCheck={false}
          className={`min-w-0 flex-1 rounded-[7px] border bg-surface-2 px-2.5 py-1 text-[12px] outline-none placeholder:text-faint ${
            editing ? "border-accent" : "border-line"
          }`}
        />
        <button
          onClick={async () => {
            if (ports) return setPorts(null);
            try {
              setPorts(await api<ListeningPort[]>("/api/ports"));
            } catch {
              setPorts([]);
            }
          }}
          title="open a port that is listening in the pod"
          className={navBtn}
        >
          ports
        </button>
        <button
          onPointerDown={(e) => {
            e.preventDefault();
            hiddenInput.current?.focus();
          }}
          title="on-screen keyboard"
          className={`${navBtn} min-[800px]:hidden`}
        >
          ⌨
        </button>
        {cdpUrl && (
          <span
            title={`Agents in this session reach this browser at $VK_BROWSER_CDP (${cdpUrl})`}
            className="hidden flex-none text-[10.5px] text-faint min-[800px]:inline"
          >
            cdp :{cdpUrl.split(":").at(-1)}
          </span>
        )}
      </div>
      {ports && (
        <div className="border-b border-line bg-surface px-2 py-1 font-mono text-[12px]">
          {ports.length === 0 && <span className="px-1 text-faint">nothing listening</span>}
          {ports.map((p) => (
            <button
              key={`${p.url}`}
              onClick={() => {
                send({ t: "nav", url: p.url });
                setPorts(null);
              }}
              className="mr-1 rounded-md border border-line px-2 py-0.5 text-muted hover:border-faint hover:text-text"
            >
              :{p.port} <span className="text-faint">{p.process}</span>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="border-b border-line bg-surface px-2.5 py-1 font-mono text-[11px] text-wait">
          {error}
        </div>
      )}
      <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
        {/* On-screen keyboard relay: focusing this summons the mobile keyboard;
            typed/deleted characters are diffed against the sentinel and sent
            as remote key events. */}
        <input
          ref={hiddenInput}
          defaultValue={SENTINEL}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onInput={(e) => {
            const el = e.currentTarget;
            const val = el.value;
            if (val.length < SENTINEL.length) {
              for (let i = val.length; i < SENTINEL.length; i++) pressKey("Backspace", 8);
            } else {
              for (const ch of val.slice(SENTINEL.length)) pressKey(ch, 0, ch);
            }
            el.value = SENTINEL;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pressKey("Enter", 13, "\r");
            }
          }}
          className="absolute top-0 left-0 h-px w-px opacity-0"
        />
        <canvas
          ref={canvasRef}
          tabIndex={0}
          onMouseDown={(e) => {
            e.currentTarget.focus();
            mouse(e, "mousePressed");
          }}
          onMouseUp={(e) => mouse(e, "mouseReleased")}
          onMouseMove={(e) => mouse(e, "mouseMoved")}
          onWheel={(e) => {
            send({
              t: "mouse",
              type: "mouseWheel",
              ...toRemote(e),
              deltaX: -e.deltaX,
              deltaY: -e.deltaY,
              modifiers: modifiers(e),
            });
          }}
          onKeyDown={(e) => key(e, "keyDown")}
          onKeyUp={(e) => key(e, "keyUp")}
          onContextMenu={(e) => e.preventDefault()}
          onTouchStart={(e) => {
            const t = e.touches[0]!;
            touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchMove={(e) => {
            // One-finger drag scrolls the remote page.
            const t = e.touches[0]!;
            const prev = touch.current;
            if (!prev) return;
            send({
              t: "mouse",
              type: "mouseWheel",
              ...toRemote(t),
              deltaX: t.clientX - prev.x,
              deltaY: t.clientY - prev.y,
            });
            touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchEnd={(e) => {
            // A tap (no movement) becomes a click.
            const start = touch.current;
            touch.current = null;
            const t = e.changedTouches[0]!;
            if (!start) return;
            if (Math.abs(t.clientX - start.x) + Math.abs(t.clientY - start.y) > 8) return;
            const pos = toRemote(t);
            send({ t: "mouse", type: "mousePressed", ...pos, button: "left", clickCount: 1 });
            send({ t: "mouse", type: "mouseReleased", ...pos, button: "left", clickCount: 1 });
          }}
          className="h-full w-full touch-none outline-none"
        />
        {disconnected && (
          <button
            onClick={() => setAttempt((a) => a + 1)}
            className="absolute inset-0 z-10 flex items-center justify-center bg-term/80 font-mono text-[13px] text-muted"
          >
            disconnected — tap to reconnect
          </button>
        )}
      </div>
    </div>
  );
}
