import { useRef, type ReactNode, type Ref } from "react";

/**
 * The composer's icons, drawn rather than typed.
 *
 * These were the glyphs "+", "((•))", "●" and "↑". No mono font ships the last
 * three, so each came from whatever fallback the platform picked and they
 * landed at different weights and sizes in a row four buttons wide — the same
 * fault the top bar's two icons had before they were drawn.
 */
export function Ico({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** How many images one attach takes; the rest are named as left out. */
export const MAX_ATTACH = 4;

/**
 * The images a paste carries. `files` alone is not enough: a screenshot taken
 * with Win+Shift+S sits on the clipboard as a bitmap rather than as a file, and
 * not every browser synthesises a File for it — `items` carries it and `files`
 * stays empty.
 */
export function pastedImages(data: DataTransfer): File[] {
  const carried = data.files.length
    ? Array.from(data.files)
    : Array.from(data.items)
        .filter((i) => i.kind === "file")
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
  return carried.filter((f) => f.type.startsWith("image/"));
}

/**
 * Where a message is written, for the assistant and for a session alike.
 *
 * There were two, and they had drifted: a paste fix made in one was missing
 * from the other, one showed nothing while an image uploaded, one dropped the
 * fifth image without a word (C-22). What differs between the two screens is
 * what an attached image becomes and which extra buttons sit beside send, so
 * those are what is passed in.
 */
export default function Composer({
  value,
  onChange,
  onSend,
  onAttach,
  onRefused,
  attaching = false,
  canSend,
  showSend = true,
  sendLabel = "send",
  label,
  placeholder,
  fieldRef,
  className = "",
  children,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  /** Images only, at most MAX_ATTACH of them. */
  onAttach: (images: File[]) => void;
  /** What was left out of an attach, said where the error line is. */
  onRefused: (why: string) => void;
  attaching?: boolean;
  canSend: boolean;
  showSend?: boolean;
  sendLabel?: string;
  label: string;
  placeholder: string;
  fieldRef: Ref<HTMLTextAreaElement>;
  className?: string;
  /** The buttons between the attach button and send: voice, stop, esc. */
  children?: ReactNode;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  function take(files: File[]) {
    const images = files.filter((f) => f.type.startsWith("image/"));
    const skipped = files.length - images.length;
    const over = Math.max(0, images.length - MAX_ATTACH);
    if (skipped) onRefused(`${skipped} file${skipped === 1 ? " is" : "s are"} not an image`);
    else if (over) onRefused(`${MAX_ATTACH} images at a time: ${over} left out`);
    if (images.length) onAttach(images.slice(0, MAX_ATTACH));
  }

  return (
    <div
      className={`rounded-3xl bg-surface-2 px-4 pt-3.5 pb-3 focus-within:ring-1 focus-within:ring-accent/60 ${className}`}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) take(Array.from(e.target.files));
          e.target.value = "";
        }}
      />
      <textarea
        ref={fieldRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, shift+enter breaks the line. On a phone the key is a
          // newline either way, which is why the button is always there.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSend) onSend();
          }
        }}
        onPaste={(e) => {
          // A screenshot pasted from the clipboard is the desktop half of the
          // attach button. A paste carrying only text pastes as it always did.
          const images = pastedImages(e.clipboardData);
          if (!images.length) return;
          e.preventDefault();
          take(images);
        }}
        rows={1}
        placeholder={placeholder}
        aria-label={label}
        // outline-none! because theme.css draws a focus ring on every
        // textarea, unlayered, and inside this card it was a second border.
        className="block max-h-32 min-h-[26px] w-full resize-none bg-transparent px-1 text-[16px] outline-none! placeholder:text-faint"
      />
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
        {/* The phone half of pasting: there is no clipboard route for a
            screenshot on iOS, so the photo library and the camera stand in. */}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={attaching}
          aria-label={attaching ? "attaching…" : "attach an image"}
          aria-busy={attaching}
          className={`tap-sq flex h-9 w-9 flex-none items-center justify-center rounded-xl text-muted hover:bg-line-strong/40 hover:text-text disabled:opacity-40 ${
            attaching ? "animate-pulse" : ""
          }`}
        >
          <Ico>
            <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </Ico>
        </button>
        <span className="flex-1" />
        {children}
        {showSend && (
          // A filled circle: it is the one action in this row that commits
          // something.
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            aria-label={sendLabel}
            className="tap-sq flex h-10 w-10 flex-none items-center justify-center rounded-full bg-accent text-on-accent transition hover:brightness-110 disabled:bg-surface disabled:text-faint"
          >
            <Ico>
              <path d="M12 19V5M5 12l7-7 7 7" />
            </Ico>
          </button>
        )}
      </div>
    </div>
  );
}
