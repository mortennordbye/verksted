import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Sheet from "./components/Sheet";
import { overlaysSettled } from "./useDismissOnBack";
import Button from "./components/ui/Button";

interface Request {
  title: string;
  body: string;
  /** Label for the button that goes through with it. */
  action: string;
  /** Destructive actions get the failure colour rather than the accent. */
  danger?: boolean;
}

/**
 * A confirm that matches the rest of the app.
 *
 * Eleven native `confirm()` calls were doing this work, and each one is a
 * browser-chrome dialog: unstyled, unreadable on a phone in landscape,
 * unlabelled beyond OK/Cancel, and — the reason it matters here — blocking,
 * which on an installed PWA renders as a jarring system alert over an
 * otherwise native-feeling app. Several of them guard a *destructive* action
 * (kill an agent, discard changes, delete a key), where "OK" tells you nothing
 * about what is about to happen.
 *
 * Kept as an await-able call so the call sites stay linear rather than each
 * growing its own open/pending/confirmed state.
 */
export function useConfirm(): [(req: Request) => Promise<boolean>, ReactNode] {
  const [request, setRequest] = useState<Request | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const answer = useRef<boolean | null>(null);

  const confirm = useCallback((req: Request) => {
    setRequest(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    answer.current = ok;
    setRequest(null);
  };

  // Answered from here rather than in settle, and only once the sheet's
  // history entry is gone. Callers navigate straight after a "yes", and a
  // navigation made before that entry's Back lands is undone by it. This
  // effect runs after the sheet's own unmount cleanup, so the Back it may
  // issue is already queued when overlaysSettled starts waiting.
  useEffect(() => {
    if (request || answer.current === null) return;
    const ok = answer.current;
    const resolve = resolver.current;
    answer.current = null;
    resolver.current = null;
    void overlaysSettled().then(() => resolve?.(ok));
  }, [request]);

  const dialog = request ? (
    // Escape, the backdrop and Android Back all reach onClose, and every one of
    // them has to mean "no" rather than leaving the promise unsettled.
    <Sheet title={request.title} sub={request.body} onClose={() => settle(false)}>
      <Button
        onClick={() => settle(true)}
        variant={request.danger ? "danger" : "primary"}
        size="lg"
        className="w-full"
      >
        {request.action}
      </Button>
    </Sheet>
  ) : null;

  return [confirm, dialog];
}
