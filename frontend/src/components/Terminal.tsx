import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import type { UploadedFile } from "../../../shared/api";
import { copyText } from "../clipboard";
import { readStoredNumber, writeStored } from "../storage";
import { api } from "../api";
import AuthLinkBar from "./terminal/AuthLinkBar";
import { findAuthUrl, findMode, MODE_SEQ, MODES } from "./terminal/scrape";
import { speechCtor, type Recognition } from "./terminal/speech";
import { KEY, KEY_IDLE, KEY_LIT, KEY_PRESS, KEY_TIGHT, KEYS } from "./terminal/keys";
import KeysSheet from "./terminal/KeysSheet";

/**
 * How many bytes may be waiting to be drawn before the pod is asked to stop
 * sending, and how few before it is asked to carry on. A screen of output is a
 * few kilobytes, so an ordinary burst never reaches this; a `cat` of something
 * large does, immediately.
 */
const WRITE_HIGH_WATER = 128 * 1024;
const WRITE_LOW_WATER = 16 * 1024;

/** How long a key keeps the pressed look after the finger lifts. */
const FLASH_MS = 160;

/**
 * Terminal font size, persisted per device.
 *
 * 13px gives about 46 columns on a 390px phone, and agent TUIs assume 80 — so
 * their boxes and diffs wrap into garbage. Being able to go down to 9 makes the
 * difference between a readable diff and a scrambled one, and it is a per-device
 * preference (a phone and a desktop want different answers), which is why it
 * lives in localStorage rather than in session metadata.
 */
const FONT_KEY = "vk.term.fontSize";
const FONT_MIN = 8;
const FONT_MAX = 22;
const FONT_DEFAULT = 13;

function storedFontSize(): number {
  return readStoredNumber(FONT_KEY, FONT_DEFAULT, FONT_MIN, FONT_MAX);
}

/** A theme token's value as the page has it, for what cannot take a class. */
function token(name: string, fallback: string): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim() || fallback
  );
}

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
  const [moreKeys, setMoreKeys] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // Consecutive failed reconnects (the backoff), and whether the server told us
  // the session is gone — in which case retrying is pointless.
  const retries = useRef(0);
  const [ended, setEnded] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  /**
   * Sign-in links this pane has finished with.
   *
   * The scan runs over the scrollback after every batch of output, and a URL
   * stays in the scrollback for good — so dismissing the bar bought one line of
   * quiet and then it came back. It matters because the match is deliberately
   * wide (any URL carrying oauth, login, verify or /device), which a link in an
   * agent's own prose can trip: that bar was undismissable until the session
   * ended.
   */
  const dismissedUrls = useRef(new Set<string>());
  const [mode, setMode] = useState<(typeof MODES)[number] | null>(null);
  const [pasteBlocked, setPasteBlocked] = useState(false);
  const [fontSize, setFontSize] = useState(storedFontSize);
  const [closeCode, setCloseCode] = useState<number | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [upload, setUpload] = useState<"idle" | "busy" | "failed">("idle");
  // Dictation: the run in progress, and whether the mic key is lit.
  const recognition = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
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

  /**
   * The same, for a key in the `more` sheet — which does not refocus.
   *
   * Nothing here needs the terminal focused (input goes down the websocket),
   * and focusing it from inside a modal sheet summons the on-screen keyboard
   * under the sheet, taking away the room the keys are standing in.
   */
  function sheetKey(id: string, run: () => void) {
    run();
    press(id);
  }

  /** Class list for a toolbar key: idle look unless pressed or already lit. */
  function keyClass(id: string, base = KEY_IDLE, box = KEY) {
    return `${box} ${KEY_PRESS} ${flash === id ? KEY_LIT : base}`;
  }

  /**
   * Dictate a prompt: one utterance per tap, typed into the pane without Enter
   * so it can be read — and edited, or thrown away with ^C — before the agent
   * sees it. Tapping again while listening stops early.
   */
  function toggleDictation() {
    if (recognition.current) {
      recognition.current.stop();
      return;
    }
    const Ctor = speechCtor();
    if (!Ctor) return;
    const rec = new Ctor();
    // The device's own language, so Norwegian dictates as Norwegian.
    rec.lang = navigator.language;
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const parts: string[] = [];
      for (let i = 0; i < e.results.length; i++) parts.push(e.results[i]?.[0]?.transcript ?? "");
      const text = parts.join(" ").trim();
      // Trailing space: dictating twice should not run the words together.
      if (text) sendInput(`${text} `);
    };
    // A refused microphone or a failed transcription just ends the attempt;
    // onend still runs, which is what puts the button back.
    rec.onerror = () => {};
    rec.onend = () => {
      recognition.current = null;
      setListening(false);
    };
    recognition.current = rec;
    setListening(true);
    rec.start();
  }

  // Pasting into an xterm terminal is awkward on a phone (no paste affordance on
  // the on-screen keyboard); send the clipboard straight in instead.
  //
  // readText has no non-secure-context fallback the way copying does — reading
  // the clipboard without an explicit paste gesture is exactly what browsers
  // refuse. On plain HTTP this button used to fail silently, so say so instead:
  // the sign-in code field below is the paste target that does work.
  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) sendInput(text);
      setPasteBlocked(false);
    } catch {
      setPasteBlocked(true);
      setTimeout(() => setPasteBlocked(false), 4000);
    }
  }

  // The terminal effect is set up once per connection, so referring to the
  // function directly would pin the first render's copy of it there for the
  // life of the socket. Everything the body touches today is a ref or a stable
  // setter, so that stale closure happens to behave — but that is a property of
  // the current body rather than of the Ctrl+Shift+V handler, and the next bit
  // of state added here would break it silently.
  const pasteRef = useRef(pasteFromClipboard);
  useLayoutEffect(() => {
    pasteRef.current = pasteFromClipboard;
  });

  // A phone has no clipboard route for screenshots, so the picker (photo
  // library / camera) stands in for pasting: upload the images, then type their
  // paths into the prompt so the agent can read them. No Enter — the user writes
  // the rest of the message around them. One request per image, in the order
  // they were picked; whatever landed gets typed even if a later one fails.
  //
  // Also where a desktop paste lands (see the paste handler below), which is why
  // the name has a fallback: a file off the clipboard can arrive nameless, and
  // the upload route requires one.
  async function sendImages(files: File[]) {
    setUpload("busy");
    const paths: string[] = [];
    let failed = false;
    for (const f of files) {
      const name = f.name || `pasted.${f.type.split("/")[1] ?? "png"}`;
      try {
        const { path } = await api<UploadedFile>(
          `/api/projects/${encodeURIComponent(project)}/upload?filename=${encodeURIComponent(name)}`,
          {
            method: "POST",
            headers: { "content-type": "application/octet-stream" },
            body: f,
            timeoutMs: 60_000,
          },
        );
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

  // Same reason pasteFromClipboard is held in a ref: the terminal effect is set
  // up once per connection, and this one closes over `project` and the upload
  // state.
  const sendImagesRef = useRef(sendImages);
  useLayoutEffect(() => {
    sendImagesRef.current = sendImages;
  });

  // Send the auth code the sign-in redirect handed back, plus Enter. A native
  // input field is where a phone can actually paste; the terminal can't.
  function sendCode(code: string) {
    sendInput(code + "\r");
    // Answered, so the link is done with — and the scan must not raise it again
    // off the scrollback it is still sitting in.
    if (authUrl) dismissedUrls.current.add(authUrl);
    setAuthUrl(null);
  }

  // Leaving the session must not leave the microphone open.
  useEffect(() => () => recognition.current?.stop(), []);

  // Font size changes must not re-create the terminal — that would drop the
  // websocket and the scrollback with it. Resize in place and refit, which
  // sends the new cols/rows on to tmux.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    fitRef.current?.fit();
    writeStored(FONT_KEY, String(fontSize));
  }, [fontSize]);

  /**
   * The terminal itself, which outlives any one connection to it.
   *
   * Keyed on the session and the pane, not on the attempt. It used to be one
   * effect for both: every backoff retry disposed the xterm and built an empty
   * one, so the "reconnecting" banner — written as a banner rather than an
   * overlay precisely so the last thing the agent printed stays readable
   * underneath it — was drawn over a blank screen. What the agent said before
   * the tunnel dropped is usually the thing you wanted to read.
   */
  useEffect(() => {
    const el = ref.current!;
    const term = new Xterm({
      cursorBlink: true,
      fontSize: storedFontSize(),
      // Wide characters (CJK, and the box-drawing and emoji agent TUIs print)
      // are measured by Unicode 6 rules by default, so anything wider than the
      // table expects shifts every column after it.
      allowProposedApi: true,
      fontFamily: token("font-term", "monospace"),
      theme: {
        // The app's own ground and ink, read from the theme rather than written
        // again here: the terminal was a fourth near-black beside the three the
        // palette has, and a light theme has to be able to reach it.
        background: token("color-term", "#0a0a0a"),
        foreground: token("color-text", "#e7e7e7"),
        cursor: token("color-text", "#e7e7e7"),
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
    fitRef.current = fit;
    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";
    // URLs an agent prints are otherwise unselectable on a phone, where there
    // is no cursor to drag across them.
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault();
        window.open(uri, "_blank", "noopener,noreferrer");
      }),
    );
    term.open(el);

    /**
     * Draw on the GPU where there is one.
     *
     * The default renderer builds a DOM node per styled run, and an agent TUI
     * repainting a full-screen box several times a second is what that costs
     * most on — a phone browser doing layout for the whole pane on every
     * frame. The addon has to be loaded after `open`, because it needs the
     * canvas the terminal has only then created.
     *
     * Every failure here falls back to that DOM renderer, which is what the
     * terminal did before and looks identical: no WebGL at all (an old phone,
     * a locked-down browser, jsdom), or a context lost afterwards — the
     * browser takes one away when the page is backgrounded or memory is tight,
     * and a disposed addon leaves the terminal drawing for itself again.
     */
    let webgl: WebglAddon | undefined;
    let gone = false;
    // Fetched rather than bundled, for the same reason highlight.js is: this
    // is the chunk a notification tap downloads before the terminal appears,
    // and 29 KB of renderer is not worth delaying the first frame of it. The
    // pane opens on the DOM renderer, exactly as it did, and moves onto the
    // GPU a moment later. The check comes first so a browser without WebGL2
    // does not fetch a renderer it cannot use.
    if (typeof WebGL2RenderingContext !== "undefined") {
      void import("@xterm/addon-webgl")
        .then(({ WebglAddon }) => {
          if (gone) return;
          const addon = new WebglAddon();
          // The browser takes a context away when the page is backgrounded or
          // memory is tight. Disposing the addon hands the drawing back.
          addon.onContextLoss(() => {
            addon.dispose();
            webgl = undefined;
          });
          term.loadAddon(addon);
          webgl = addon;
        })
        .catch(() => {
          // No WebGL after all, or the chunk never arrived: the DOM renderer
          // is already drawing and nothing about the pane looks different.
        });
    }

    fit.fit();
    // On a desktop the terminal is the point of the screen, and it used to need
    // a click before it would take a keystroke. Not on touch, where focusing
    // would throw the on-screen keyboard up over the pane on arrival.
    if (matchMedia("(pointer: fine)").matches) term.focus();
    termRef.current = term;

    // One text row in CSS pixels — fit() sizes rows to this box, so the box
    // height over the row count is the row height.
    const rowHeight = () => Math.max(1, el.clientHeight / term.rows);

    // Wheel and trackpad. Returning false stops xterm's own handling, which in
    // the alternate screen is the ↑/↓ conversion we are replacing — unless the
    // app asked for mouse events, in which case xterm already sends it exactly
    // the wheel report it is waiting for.
    // Ctrl+Shift+C/V is what a terminal uses for copy/paste, since plain Ctrl+C
    // has to reach the agent as an interrupt.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown" || !ev.ctrlKey || !ev.shiftKey) return true;
      const key = ev.key.toLowerCase();
      if (key === "c") {
        const selection = term.getSelection();
        if (selection) void copyText(selection);
        return false;
      }
      if (key === "v") {
        void pasteRef.current();
        return false;
      }
      return true;
    });

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

    // Pasting a screenshot into a session. The agent's own ^V cannot do this:
    // it reads the clipboard of the machine the CLI runs on, which is the pod,
    // which has none — hence "no images in clipboard". The bytes are here, in
    // the browser, and a paste gesture is the one way a page gets them without
    // a secure context (navigator.clipboard.read is unavailable over plain
    // HTTP). So: intercept the gesture and take the same route the phone
    // picker does — upload, then type the path in for the agent to read.
    //
    // Capture, so this runs before xterm's own handler on the textarea beneath;
    // a paste carrying only text is left alone and pastes as it always did.
    //
    // `files` alone is not enough: a screenshot taken with Win+Shift+S sits on
    // the clipboard as a bitmap rather than as a file, and not every browser
    // synthesises a File for it — `items` carries it and `files` stays empty.
    // The paste then falls through to xterm, which has no text to insert
    // either, so the gesture does nothing at all.
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const carried = data.files.length
        ? Array.from(data.files)
        : Array.from(data.items)
            .filter((i) => i.kind === "file")
            .map((i) => i.getAsFile())
            .filter((f): f is File => f !== null);
      const files = carried.filter((f) => f.type.startsWith("image/"));
      if (!files.length) return;
      e.preventDefault();
      e.stopPropagation();
      void sendImagesRef.current(files);
    };
    el.addEventListener("paste", onPaste, true);

    const input = term.onData((data) => {
      pendingScroll.current = 0;
      setScrolled(false);
      // Disarm on whatever comes next, not only on a letter: arming and then
      // typing a digit used to leave Ctrl silently armed for the next letter.
      if (ctrlArmed.current && /^[a-zA-Z]$/.test(data)) {
        ctrlArmed.current = false;
        setCtrl(false);
        data = String.fromCharCode(data.toUpperCase().charCodeAt(0) - 64);
      }
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "in", data }));
    });

    // Refit only. What the new geometry is worth telling tmux is sent by
    // `term.onResize` below, which also covers the font size — fit() after a
    // font change leaves this box exactly the size it was, so the observer
    // never fires and tmux kept the old cols and rows.
    let debounce: number | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(debounce);
      debounce = window.setTimeout(() => fit.fit(), 100);
    });
    ro.observe(el);

    const resized = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "resize", cols, rows }));
    });

    return () => {
      clearTimeout(debounce);
      clearTimeout(scrollTimer.current);
      clearTimeout(flashTimer.current);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("paste", onPaste, true);
      ro.disconnect();
      input.dispose();
      resized.dispose();
      gone = true;
      webgl?.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId, shell]);

  /**
   * The connection to it, which does not: every retry replaces this one and
   * leaves the screen above alone.
   */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
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
      // tmux repaints the whole pane on attach. The frame from before the drop
      // is still on screen now that the terminal survives one, so it is cleared
      // here rather than left for the repaint to land on top of.
      if (attempt > 0) term.reset();
      setDisconnected(false);
      retries.current = 0;
    };
    /**
     * How much output has been handed to xterm and not drawn yet.
     *
     * A terminal cannot paint a build log as fast as a pod can print one, and
     * the difference has nowhere to go but this page: `write` queues, the
     * queue grows for as long as the flood lasts, and on a phone that is the
     * tab being killed. Past the high mark the pod is asked to stop reading
     * the pty until the queue has drained, which is a pause the agent itself
     * sees — the same way a slow terminal slows a command on a desk.
     */
    let pending = 0;
    let asked = false;
    const flow = (on: boolean) => {
      asked = !on;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "flow", on }));
    };

    ws.onmessage = (e) => {
      const data = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      pending += data.length;
      if (!asked && pending > WRITE_HIGH_WATER) flow(false);
      term.write(data, () => {
        pending -= data.length;
        if (asked && pending <= WRITE_LOW_WATER) flow(true);
      });
      // Debounced so we scan settled output, not every partial frame.
      clearTimeout(scanTimer);
      scanTimer = window.setTimeout(() => {
        const url = findAuthUrl(term);
        if (url && !dismissedUrls.current.has(url)) setAuthUrl(url);
        // Sticky: while the agent works it replaces the status line with its
        // own hints, and the mode hasn't changed just because it scrolled off.
        const m = findMode(term);
        if (m) setMode(m);
      }, 400);
    };
    ws.onclose = (e) => {
      // Codes the attach route uses to say retrying is pointless: 4404 the
      // session is gone (ended or purged), 4429 too many clients are already
      // attached, 4500 the pty could not be started at all.
      if (!unmounted) {
        if (e.code === 4404 || e.code === 4429 || e.code === 4500) setEnded(true);
        setCloseCode(e.code);
        setDisconnected(true);
      }
    };

    return () => {
      unmounted = true;
      clearTimeout(scanTimer);
      ws.close();
      wsRef.current = null;
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
      {/* One row, and it wraps rather than scrolls: a key that is off the edge
          of the screen is a key that does not exist. */}
      {/* The keys are `tap-hit`, not `tap`: 44px of box here is 16px of
          terminal, and the same finger target comes from an overlay instead.
          That overlay overhangs 8px above and below, which is why the row gap
          is 10px and not the 4px between columns — two wrapped lines at gap-1
          would put each line's overlay over the other's visible keys, and the
          later one in the DOM wins the tap. The same 8px reaches ~5px up into
          the `mb-2` above the pane box, so if that gap is ever trimmed the top
          key row starts stealing the bottom of the ⋯ beside it. */}
      <div className="hidden flex-none flex-wrap gap-x-1 gap-y-2.5 border-b border-line bg-surface px-1.5 py-0.5 pointer-coarse:flex">
        {/* First, and it doubles as the readout for a status line the on-screen
            keyboard covers. */}
        <button
          onClick={() => tapKey("mode", () => sendInput(MODE_SEQ))}
          title="cycle permission mode (shift+tab)"
          className={keyClass("mode", mode ? mode.tone : KEY_IDLE, KEY_TIGHT)}
        >
          {mode?.label ?? "mode"}
        </button>
        {KEYS.filter((k) => k.row === 1).map((k) => (
          <button
            key={k.label}
            onClick={() => tapKey(k.label, () => sendInput(k.seq))}
            title={k.title}
            aria-label={k.title ?? k.label}
            className={keyClass(k.label, KEY_IDLE, KEY_TIGHT)}
          >
            {k.label}
          </button>
        ))}
        {/* Never sends anything, so it does not go through tapKey's input
            path. It does not refocus the terminal either: the sheet it opens
            is modal, and summoning the on-screen keyboard underneath it is
            how you end up unable to see the keys you just asked for. */}
        <button
          onClick={() => {
            setMoreKeys(true);
            press("more");
          }}
          aria-haspopup="dialog"
          aria-expanded={moreKeys}
          title="more keys, paste, mic, text size"
          className={keyClass("more", ctrl || listening ? KEY_LIT : KEY_IDLE, KEY_TIGHT)}
        >
          more
        </button>
        {/* Lives in the bar rather than the sheet so the picker survives the
            sheet closing — iOS reports the chosen files on a later tick. */}
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
      </div>

      {moreKeys && (
        <KeysSheet
          keyClass={keyClass}
          sheetKey={sheetKey}
          ctrl={ctrl}
          onCtrl={() => {
            ctrlArmed.current = !ctrlArmed.current;
            setCtrl(ctrlArmed.current);
          }}
          pasteBlocked={pasteBlocked}
          onPaste={pasteFromClipboard}
          listening={listening}
          onMic={toggleDictation}
          upload={upload}
          onImage={() => {
            press("img");
            picker.current?.click();
          }}
          onSend={sendInput}
          onScroll={(pages) => scrollBy(pages * ((termRef.current?.rows ?? 24) - 2))}
          onKeyboard={() => {
            setMoreKeys(false);
            termRef.current?.focus();
          }}
          fontSize={fontSize}
          onFontSize={(n) => setFontSize(Math.min(FONT_MAX, Math.max(FONT_MIN, n)))}
          onClose={() => setMoreKeys(false)}
        />
      )}
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
        {/* A banner, not a full-pane overlay: the last thing the agent printed
            is exactly what you want to read when the connection drops, and the
            overlay used to cover it. */}
        {disconnected && (
          <button
            onClick={() => setAttempt((a) => a + 1)}
            className="absolute inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-3 py-2 text-left font-mono text-[12.5px] text-muted backdrop-blur"
          >
            {closeCode === 4429
              ? "too many terminals open on this session — close one and tap to retry"
              : ended
                ? "this session has ended — start a new one with “resume” to pick the conversation up"
                : "reconnecting — tap to retry now"}
          </button>
        )}
      </div>
      {authUrl && (
        <AuthLinkBar
          url={authUrl}
          onDismiss={() => {
            dismissedUrls.current.add(authUrl);
            setAuthUrl(null);
          }}
          onCode={sendCode}
        />
      )}
    </div>
  );
}
