import { diffLineClass } from "../diff";
import { useOverlayDismiss } from "../useDismissOnBack";

/**
 * Full-screen text viewer for a PR diff or a failed run's log. Colours diff
 * lines when asked; otherwise renders the text as it came.
 */
export default function CodeOverlay({
  title,
  text,
  diff,
  truncated,
  onClose,
}: {
  title: string;
  text: string;
  diff?: boolean;
  truncated?: boolean;
  onClose: () => void;
}) {
  // This overlay had neither: Escape did nothing, and Android Back left the
  // screen entirely instead of closing the viewer.
  useOverlayDismiss(true, onClose);

  const lines = text.split("\n");
  return (
    <div
      // Presentational: clicking away duplicates Escape, Back and the ✕ button.
      role="presentation"
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-line bg-surface"
      >
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
          <span className="min-w-0 truncate">{title}</span>
          {/* The way out of a full-screen overlay on a phone, so it gets the
              44px the rest of the app's icon controls have. */}
          <button
            onClick={onClose}
            aria-label="close"
            className="tap-sq ml-auto flex flex-none items-center justify-center px-2 text-faint hover:text-text"
          >
            ✕
          </button>
        </div>
        <pre className="flex-1 overflow-auto p-4 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
          {truncated && (
            <div className="mb-2 text-[11px] text-wait">
              {diff ? "…too long, the rest is on GitHub" : "…earlier output trimmed"}
            </div>
          )}
          {lines.map((line, i) => (
            <div key={i} className={diff ? diffLineClass(line) : "text-muted"}>
              {line || " "}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
}
