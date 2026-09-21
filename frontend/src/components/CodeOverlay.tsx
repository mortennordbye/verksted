import { diffLineClass } from "../diff";
import Overlay, { OverlayHeader } from "./ui/Overlay";

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
    <Overlay
      label={title}
      onClose={onClose}
      className="h-[85dvh] w-full max-w-[860px] overflow-hidden rounded-xl"
    >
      <OverlayHeader title={title} onClose={onClose} />
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
    </Overlay>
  );
}
