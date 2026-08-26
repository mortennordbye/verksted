import { useEffect, useRef } from "react";

/**
 * A composer that is as tall as what has been typed into it.
 *
 * Both fields were `rows={1}` with a max-height, which is a one-line window
 * onto a message that can be a paragraph: the text scrolls inside it and you
 * can see the line you are on and nothing else. Re-reading what you wrote
 * before sending it meant scrolling a box the height of the words in it.
 *
 * Measured rather than counted, because a soft-wrapped line is still one line
 * as far as the value is concerned — `scrollHeight` is the only thing that
 * knows how tall the text actually got. Reset to auto first or it can only ever
 * grow: `scrollHeight` on an element already stretched to fit reports the
 * stretched height, so deleting a line would leave the gap behind.
 *
 * Keyed on the value rather than driven from onChange so that dictation, a
 * tapped suggestion, and the clear after a send all shrink it back too.
 *
 * The cap stays in CSS (`max-h-*`), where it belongs — past it the element
 * scrolls, as a textarea does.
 */
export function useGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}
