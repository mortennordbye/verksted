import { useCallback, useRef, useState, type ReactNode } from "react";
import Sheet from "./components/Sheet";

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

  const confirm = useCallback((req: Request) => {
    setRequest(req);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = (ok: boolean) => {
    setRequest(null);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const dialog = request ? (
    // Escape, the backdrop and Android Back all reach onClose, and every one of
    // them has to mean "no" rather than leaving the promise unsettled.
    <Sheet title={request.title} sub={request.body} onClose={() => settle(false)}>
      <button
        onClick={() => settle(true)}
        className={`tap w-full rounded-[11px] px-3.5 py-3 font-mono text-[13px] font-semibold ${
          request.danger ? "bg-fail text-[#1a0e0e]" : "bg-accent text-[#16130a]"
        }`}
      >
        {request.action}
      </button>
    </Sheet>
  ) : null;

  return [confirm, dialog];
}
