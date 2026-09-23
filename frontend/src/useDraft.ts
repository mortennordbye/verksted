import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/**
 * A composer's text that outlives the screen it is typed on.
 *
 * Tapping a citation chip, or a phone reloading a backgrounded tab, used to
 * throw away a half-written message (C-21). Kept in sessionStorage rather than
 * localStorage: a draft belongs to this tab, and one left behind a week ago is
 * not something to find in the field. Wrapped for the same reason storage.ts
 * is: some browsers throw on the getter.
 */
function read(key: string): string {
  try {
    return sessionStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

export function useDraft(key: string): [string, Dispatch<SetStateAction<string>>] {
  const [text, setText] = useState(() => read(key));
  const [heldFor, setHeldFor] = useState(key);
  // Another session's screen reuses this component: take up its draft instead.
  if (heldFor !== key) {
    setHeldFor(key);
    setText(read(key));
  }
  useEffect(() => {
    try {
      if (text) sessionStorage.setItem(heldFor, text);
      else sessionStorage.removeItem(heldFor);
    } catch {
      // Blocked: the draft lives as long as the screen does, as it used to.
    }
  }, [heldFor, text]);
  return [text, setText];
}
