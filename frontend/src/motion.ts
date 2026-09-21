/**
 * How a scroll this app starts should move. CSS can switch an animation off for
 * someone who asked for none; a `scrollTo` with `behavior: "smooth"` is decided
 * in script, so it has to ask.
 */
export function scrollBehavior(): ScrollBehavior {
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return reduce ? "auto" : "smooth";
}
