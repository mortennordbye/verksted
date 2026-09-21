import Sheet from "../Sheet";
import { KEY_IDLE, KEY_LIT, KEYS } from "./keys";
import { speechCtor } from "./speech";

/**
 * The `more` sheet: the keys a phone's on-screen keyboard has not got, the
 * clipboard, the mic, an image, paging the scrollback, and the text size.
 *
 * Everything it does is the terminal's, handed in; this is only the sheet.
 */
export default function KeysSheet({
  keyClass,
  sheetKey,
  ctrl,
  onCtrl,
  pasteBlocked,
  onPaste,
  listening,
  onMic,
  upload,
  onImage,
  onSend,
  onScroll,
  onKeyboard,
  fontSize,
  onFontSize,
  onClose,
}: {
  keyClass: (id: string, base?: string) => string;
  /** Runs a key and shows it pressed, without refocusing the terminal. */
  sheetKey: (id: string, run: () => void) => void;
  ctrl: boolean;
  onCtrl: () => void;
  pasteBlocked: boolean;
  onPaste: () => Promise<void> | void;
  listening: boolean;
  onMic: () => void;
  upload: "idle" | "busy" | "failed";
  onImage: () => void;
  onSend: (seq: string) => void;
  /** Pages of scrollback: positive is back, negative is forward. */
  onScroll: (pages: number) => void;
  onKeyboard: () => void;
  fontSize: number;
  onFontSize: (next: number) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title="keys" sub="what the on-screen keyboard has not got" onClose={onClose}>
      <div className="flex flex-wrap gap-1.5">
        <button
          onClick={() => sheetKey("ctrl", onCtrl)}
          className={keyClass("ctrl", ctrl ? KEY_LIT : KEY_IDLE)}
        >
          ctrl
        </button>
        <button
          onClick={() => sheetKey("paste", () => void onPaste())}
          title={
            pasteBlocked
              ? "the browser will not hand over the clipboard on this origin"
              : "paste the clipboard into the terminal"
          }
          className={keyClass("paste", pasteBlocked ? "border-fail text-fail" : KEY_IDLE)}
        >
          {pasteBlocked ? "no clipboard" : "paste"}
        </button>
        {speechCtor() && (
          <button
            onClick={() => sheetKey("mic", onMic)}
            title="dictate into the terminal"
            className={keyClass("mic", listening ? KEY_LIT : KEY_IDLE)}
          >
            {listening ? "◉ mic" : "mic"}
          </button>
        )}
        <button
          onClick={onImage}
          disabled={upload === "busy"}
          className={keyClass("img", upload === "failed" ? "border-wait text-wait" : KEY_IDLE)}
        >
          {upload === "busy" ? "…" : upload === "failed" ? "img ✕" : "img"}
        </button>
        {KEYS.filter((k) => k.row === 2).map((k) => (
          <button
            key={k.label}
            onClick={() => sheetKey(k.label, () => onSend(k.seq))}
            title={k.title}
            aria-label={k.title ?? k.label}
            className={keyClass(k.label)}
          >
            {k.label}
          </button>
        ))}
        {/* A page of history at a time — the same scrollback the drag gesture
        moves, not the PgUp/PgDn keys the agent would swallow.

        Labelled in words rather than ⌨ ⇞ ⇟: no mono font here ships those
        three, so each came from a fallback and rendered as an empty box. */}
        <button
          onClick={() => sheetKey("pgup", () => onScroll(1))}
          title="scroll back"
          className={keyClass("pgup")}
        >
          pg↑
        </button>
        <button
          onClick={() => sheetKey("pgdn", () => onScroll(-1))}
          title="scroll forward"
          className={keyClass("pgdn")}
        >
          pg↓
        </button>
        {/* iOS drops the on-screen keyboard whenever focus moves — to the
        file picker, a key, or nothing at all — and there is no way back
        without tapping the terminal body, which in copy mode means
        scrolling it. Closes the sheet first: it is asking for the keyboard,
        which needs the space this is standing in. */}
        <button
          onClick={onKeyboard}
          title="show the keyboard"
          aria-label="show the keyboard"
          className={keyClass("kbd")}
        >
          kbd
        </button>
      </div>

      {/* Font steppers: 13px is ~46 columns on a phone, and agent TUIs draw
          for 80 — their boxes and diffs wrap into noise below that. Given
          their own row with the current size shown, because two unlabelled
          A's in a row of two dozen keys never said what they sized. */}
      <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-3">
        <span className="mr-auto text-[13px] text-muted">text size</span>
        <button
          onClick={() => sheetKey("a-", () => onFontSize(fontSize - 1))}
          title="smaller text (more columns)"
          aria-label="smaller text"
          className={keyClass("a-")}
        >
          A−
        </button>
        <span className="w-[52px] text-center font-mono text-[12px] text-faint">{fontSize}px</span>
        <button
          onClick={() => sheetKey("a+", () => onFontSize(fontSize + 1))}
          title="larger text (fewer columns)"
          aria-label="larger text"
          className={keyClass("a+")}
        >
          A+
        </button>
      </div>
    </Sheet>
  );
}
