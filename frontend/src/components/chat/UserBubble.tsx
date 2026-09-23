import type { ReactNode } from "react";

const SIZE = {
  // The assistant's room, where your words are most of the screen.
  lg: "rounded-[20px] rounded-br-[6px] px-[18px] py-3 text-[15.5px] leading-[1.5]",
  // A session's conversation, beside tool chips and a terminal.
  sm: "rounded-[14px] rounded-br-[5px] px-3 py-2 text-[14px]",
} as const;

/**
 * What you said, on the right. `pending` is sent and not yet on record, drawn
 * tinted until the server or the transcript has it (C-13). One component for
 * what was the same markup four times at two sizes (C-35).
 */
export default function UserBubble({
  size,
  pending = false,
  className = "",
  children,
}: {
  size: keyof typeof SIZE;
  pending?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`max-w-[82%] font-medium whitespace-pre-wrap ${SIZE[size]} ${
        pending ? "bg-accent-tint text-text ring-1 ring-accent/30" : "bg-accent text-on-accent"
      } ${className}`}
    >
      {children}
    </div>
  );
}
