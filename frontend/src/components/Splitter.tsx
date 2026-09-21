import { useRef } from "react";

/**
 * A draggable edge between two panes: the WAI-ARIA window splitter.
 *
 * The session screen had two of these, the sidebar's edge and the line between
 * the agent and its companion pane, written out twice with the same pointer
 * capture, the same arrow keys and the same double-click reset. A focusable
 * separator with a value is an interactive widget; the lint rule only knows
 * that "separator" is non-interactive by default.
 */
export default function Splitter({
  label,
  value,
  min,
  max,
  step,
  reset,
  at,
  onChange,
  className,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  /** How far one arrow press moves it. */
  step: number;
  /** Where Home and a double-click put it back. */
  reset: number;
  /** The value a pointer at this x means. */
  at: (clientX: number, el: HTMLDivElement) => number;
  onChange: (next: number) => void;
  className: string;
}) {
  const dragging = useRef(false);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (dragging.current) onChange(clamp(at(e.clientX, e.currentTarget)));
      }}
      onPointerUp={(e) => {
        dragging.current = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onDoubleClick={() => onChange(reset)}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onChange(clamp(value - step));
        else if (e.key === "ArrowRight") onChange(clamp(value + step));
        else if (e.key === "Home") onChange(reset);
        else return;
        e.preventDefault();
      }}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      // Being focusable is what makes it usable without a mouse.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      title="drag to resize · double-click to reset · arrow keys"
      className={`cursor-col-resize touch-none hover:bg-accent/60 ${className}`}
    />
  );
}
