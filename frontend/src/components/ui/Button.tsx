import type { ComponentProps } from "react";

/**
 * What a button is for. Primary goes through with the thing the panel exists
 * to do; danger is primary for something that cannot be taken back. Ghost is
 * every secondary action, and ghost-danger a secondary one that destroys
 * something, which says so only on hover, in the failure colour the confirm
 * after it uses.
 */
const VARIANT = {
  primary: "bg-accent font-semibold text-on-accent hover:brightness-110",
  danger: "bg-fail font-semibold text-on-fail hover:brightness-110",
  ghost: "border border-line text-muted hover:border-line-strong hover:text-text",
  "ghost-danger": "border border-line text-muted hover:border-fail/60 hover:text-fail",
} as const;

/**
 * lg is a sheet's or a card's one action; sm sits in a row with a field; xs is
 * a row's own small actions, where a 44px box would stretch the row, so it
 * reaches the finger with `tap-hit` instead of growing.
 */
const SIZE = {
  xs: "tap-hit rounded-md px-2 py-1 text-[11.5px]",
  sm: "tap rounded-[7px] px-2.5 py-1.5 text-[12.5px]",
  lg: "tap rounded-lg px-3.5 py-2.5 text-[13.5px]",
} as const;

export type ButtonVariant = keyof typeof VARIANT;
export type ButtonSize = keyof typeof SIZE;

/**
 * The classes, for the few things that look like a button and are not one: a
 * link that leaves the app, a router Link.
 */
export function buttonClass(variant: ButtonVariant = "ghost", size: ButtonSize = "sm", extra = "") {
  return `inline-flex items-center justify-center gap-1.5 disabled:opacity-50 ${SIZE[size]} ${VARIANT[variant]} ${extra}`;
}

/**
 * The app's button.
 *
 * Twenty-nine primary buttons outside the chat had nine different radii, three
 * of them in the mono face; the ghost button was pasted into three files, eight
 * times in Settings alone; the danger hover was the waiting colour in most
 * places and the failure colour in one. Three sizes and four variants cover every
 * one of them. `type` defaults to "button", since a button inside a form that
 * submits it by accident is the one surprise nobody wants from a default.
 */
export default function Button({
  variant = "ghost",
  size = "sm",
  className = "",
  type = "button",
  ...rest
}: ComponentProps<"button"> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
