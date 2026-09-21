import type { ComponentProps } from "react";

const BOX =
  "max-w-full min-w-0 border border-line bg-surface-2 outline-none placeholder:text-faint focus:border-accent disabled:opacity-50";

/** sm sits in a panel's row; lg is a sheet's one question, or a page's search. */
const SIZE = {
  sm: { box: "rounded-[7px] px-2.5 py-1.5", sans: "text-[12.5px]", mono: "font-mono text-[12px]" },
  lg: { box: "rounded-[11px] px-3.5 py-3", sans: "text-[14px]", mono: "font-mono text-[14px]" },
} as const;

/**
 * The field's box. Mono for what is typed as a machine reads it (a cron, a
 * path, a token, a repo), sans for words (a name, a prompt, a choice between
 * named things). The same box was redefined in ten places, at five text sizes.
 */
export function fieldClass(mono = false, extra = "", size: keyof typeof SIZE = "sm") {
  const s = SIZE[size];
  return `${BOX} ${s.box} ${mono ? s.mono : s.sans} ${extra}`;
}

/**
 * What every field has to say about itself: its name.
 *
 * About seventeen inputs were labelled by their placeholder alone, which a
 * screen reader may not read and which is gone the moment anything is typed.
 * The name is required here, so a field without one does not compile. It is
 * the accessible name; where a visible label sits beside the field, it says
 * the same thing.
 */
interface Named {
  label: string;
  mono?: boolean;
  size?: keyof typeof SIZE;
}

export function Input({
  label,
  mono = false,
  size = "sm",
  className = "",
  ...rest
}: Omit<ComponentProps<"input">, "aria-label" | "size"> & Named) {
  return <input aria-label={label} className={fieldClass(mono, className, size)} {...rest} />;
}

export function Textarea({
  label,
  mono = false,
  size = "sm",
  className = "",
  ...rest
}: Omit<ComponentProps<"textarea">, "aria-label"> & Named) {
  return (
    <textarea
      aria-label={label}
      className={fieldClass(mono, `resize-y ${className}`, size)}
      {...rest}
    />
  );
}

export function Select({
  label,
  mono = false,
  size = "sm",
  className = "",
  ...rest
}: Omit<ComponentProps<"select">, "aria-label" | "size"> & Named) {
  return <select aria-label={label} className={fieldClass(mono, className, size)} {...rest} />;
}
