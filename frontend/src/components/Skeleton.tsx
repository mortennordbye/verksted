/**
 * A grey stand-in the shape of what is still loading.
 *
 * Shape and colour come entirely from the caller, since a card, a headline and
 * a line of text each want their own. A span so it can sit inside a heading;
 * pass `block` for anything that stacks. It stays invisible for its first
 * 150ms (see --animate-skeleton), so a quick answer never flashes it.
 */
export default function Skeleton({ className }: { className: string }) {
  return (
    <span aria-hidden className={`animate-skeleton-in motion-safe:animate-skeleton ${className}`} />
  );
}

/** Ragged rather than even: a block of equal bars reads as a table, not text. */
const WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-2/5", "w-5/6"];

/** Lines of text that have not arrived: a log, a file, a diff. */
export function SkeletonLines({ count, className = "" }: { count: number; className?: string }) {
  return (
    <span aria-hidden className={`flex flex-col gap-2 ${className}`}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton
          key={i}
          className={`block h-3 rounded bg-surface-2 ${WIDTHS[i % WIDTHS.length]}`}
        />
      ))}
    </span>
  );
}

/** The same card n times, stacked: a list that has not arrived. */
export function SkeletonList({
  count,
  className,
  gap = "gap-2",
}: {
  count: number;
  className: string;
  gap?: string;
}) {
  return (
    <span aria-hidden className={`flex flex-col ${gap}`}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className={`block ${className}`} />
      ))}
    </span>
  );
}
