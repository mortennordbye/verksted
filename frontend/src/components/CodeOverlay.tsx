import { diffLineClass } from "../diff";

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
  const lines = text.split("\n");
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex h-[80vh] w-full max-w-[860px] flex-col overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
          <span className="min-w-0 truncate">{title}</span>
          <button onClick={onClose} className="ml-auto flex-none px-2 text-faint hover:text-text">
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
