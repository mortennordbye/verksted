import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
  type MouseEvent as RMouseEvent,
} from "react";
import type { BrowserClientMsg, BrowserServerMsg, ListeningPort } from "../../../shared/api";
import { api } from "../api";
import Button from "./ui/Button";
import Icon from "./Icon";
import Notice from "./ui/Notice";

// The on-screen keyboard relay keeps a sentinel in the hidden input so
// Backspace always changes the value (and therefore always fires oninput).
const SENTINEL = "​​​​";

// CDP Input modifier bits.
function modifiers(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

const BUTTONS = ["left", "middle", "right"] as const;

export default function BrowserPane({ wsPath }: { wsPath: string }) {
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
  // A failed scan used to render as "nothing listening", which is a
  // different and much more misleading statement than "the scan failed".
  const [portsError, setPortsError] = useState<string | null>(null);

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
    const ws = new WebSocket(`${proto}://${location.host}${wsPath}`);
    wsRef.current = ws;
    let unmounted = false;

    /**
     * The newest frame that has not been painted yet, and whether one is
     * being decoded now.
     *
     * Every frame used to be given its own `Image`, and a JPEG decode is
     * asynchronous: two frames that arrive close together finish in whichever
     * order the browser gets to them, so a slower older one could land on top
     * of a newer one and leave the pane showing the page as it was. Decoding
     * one at a time fixes the order, and what arrives meanwhile collapses to
     * the last of them — a frame nobody ever saw is not worth decoding, and on
     * a phone it is the decode, not the tunnel, that cannot keep up.
     */
    let pending: { data: string; w: number; h: number } | null = null;
    let decoding = false;

    const paint = () => {
      const frame = pending;
      pending = null;
      if (!frame) {
        decoding = false;
        return;
      }
      decoding = true;
      const img = new Image();
      img.onload = () => {
        remote.current = { w: frame.w, h: frame.h };
        const canvas = canvasRef.current;
        if (canvas) {
          if (canvas.width !== img.width || canvas.height !== img.height) {
            canvas.width = img.width;
            canvas.height = img.height;
          }
          canvas.getContext("2d")!.drawImage(img, 0, 0);
        }
        paint();
      };
      // A truncated frame must not stop every frame after it.
      img.onerror = () => paint();
      img.src = `data:image/jpeg;base64,${frame.data}`;
    };

    ws.onopen = () => setDisconnected(false);
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data as string) as BrowserServerMsg;
      if (msg.t === "frame") {
        pending = { data: msg.data, w: msg.w, h: msg.h };
        if (!decoding) paint();
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
  }, [wsPath, attempt]);

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

  function mouse(e: RMouseEvent<HTMLCanvasElement>, type: "mousePressed" | "mouseReleased") {
    e.preventDefault();
    send({
      t: "mouse",
      type,
      ...toRemote(e),
      button: BUTTONS[e.button] ?? "left",
      clickCount: 1,
      modifiers: modifiers(e),
    });
  }

  /**
   * Where the pointer was at the last animation frame.
   *
   * A mouse reports its position as fast as it can — hundreds of times a
   * second on a desk — and each one was its own frame over the tunnel for a
   * position that is superseded before it arrives. The remote page cannot act
   * on more than it can render either, so one per frame is all of them that
   * were ever going to matter.
   */
  const moveAt = useRef<{ x: number; y: number; modifiers: number } | null>(null);
  const moveFrame = useRef(0);

  function moved(e: RMouseEvent<HTMLCanvasElement>) {
    e.preventDefault();
    moveAt.current = { ...toRemote(e), modifiers: modifiers(e) };
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      if (moveAt.current) {
        send({ t: "mouse", type: "mouseMoved", ...moveAt.current, button: "none", clickCount: 0 });
      }
    });
  }

  useEffect(() => () => cancelAnimationFrame(moveFrame.current), []);

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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-line bg-surface px-2 py-1.5 font-mono text-[11.5px]">
        <Button
          onClick={() => send({ t: "back" })}
          aria-label="back"
          size="xs"
          className="hidden min-[800px]:block"
        >
          <Icon name="back" size={12} />
        </Button>
        <Button
          onClick={() => send({ t: "forward" })}
          aria-label="forward"
          size="xs"
          className="hidden min-[800px]:block"
        >
          <Icon name="forward" size={12} />
        </Button>
        <Button onClick={() => send({ t: "reload" })} aria-label="reload" size="xs">
          <Icon name="reload" size={12} />
        </Button>
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
          aria-label="url to open"
          spellCheck={false}
          className={`min-w-0 flex-1 rounded-[7px] border bg-surface-2 px-2.5 py-1 text-[12px] outline-none placeholder:text-faint ${
            editing ? "border-accent" : "border-line"
          }`}
        />
        <Button
          onClick={async () => {
            if (ports) {
              setPortsError(null);
              return setPorts(null);
            }
            try {
              setPorts(await api<ListeningPort[]>("/api/ports"));
              setPortsError(null);
            } catch (err) {
              setPorts([]);
              setPortsError((err as Error).message);
            }
          }}
          title="open a port that is listening in the pod"
          size="xs"
        >
          ports
        </Button>
        <Button
          onPointerDown={(e) => {
            e.preventDefault();
            hiddenInput.current?.focus();
          }}
          title="on-screen keyboard"
          size="xs"
          className="min-[800px]:hidden"
        >
          ⌨
        </Button>
        {cdpUrl && (
          <span
            title={`Reachable at $VK_BROWSER_CDP (${cdpUrl})`}
            className="hidden flex-none text-[10.5px] text-faint min-[800px]:inline"
          >
            cdp :{cdpUrl.split(":").at(-1)}
          </span>
        )}
      </div>
      {ports && (
        <div className="border-b border-line bg-surface px-2 py-1 font-mono text-[12px]">
          {ports.length === 0 &&
            (portsError ? (
              <span className="px-1 text-fail">could not scan ports — {portsError}</span>
            ) : (
              <span className="px-1 text-faint">nothing listening</span>
            ))}
          {ports.map((p) => (
            <Button
              key={`${p.url}`}
              onClick={() => {
                send({ t: "nav", url: p.url });
                setPorts(null);
              }}
              size="xs"
              className="mr-1"
            >
              :{p.port} <span className="text-faint">{p.process}</span>
            </Button>
          ))}
        </div>
      )}
      {error && (
        <Notice kind="fail" small className="rounded-none">
          {error}
        </Notice>
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
          onMouseMove={moved}
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
            const t = e.touches[0];
            touch.current = { x: t.clientX, y: t.clientY };
          }}
          onTouchMove={(e) => {
            // One-finger drag scrolls the remote page.
            const t = e.touches[0];
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
            const t = e.changedTouches[0];
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
            className="absolute inset-0 z-10 flex items-center justify-center bg-term/80 text-[13.5px] text-muted scheme-dark"
          >
            disconnected — tap to reconnect
          </button>
        )}
      </div>
    </div>
  );
}
