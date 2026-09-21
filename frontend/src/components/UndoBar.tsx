import { useCallback, useEffect, useState, type ReactNode } from "react";

/** Offered for as long as it is plausibly still the thing you just did. */
const OFFER_MS = 15_000;

interface Offer {
  label: string;
  revert: () => Promise<void> | void;
}

/**
 * "Done, and here is the way back", for a tap that is cheap to make by mistake.
 *
 * The inbox had one of these in the flow of the list, above the first row: on
 * a phone, marking the thirtieth row done put the only way back four screens
 * up, and its fifteen seconds ran out where nobody could see them (F-31).
 * Today had none at all, so closing a loop or waving off a run was final
 * (F-30). This one floats at the bottom of the screen, above the phone's tab
 * bar where there is one, and is the same thing on both screens.
 *
 * `offer` replaces whatever was offered before: undo is for the last thing.
 */
export function useUndo(): [(label: string, revert: Offer["revert"]) => void, ReactNode] {
  const [offer, setOffer] = useState<Offer | null>(null);

  useEffect(() => {
    if (!offer) return;
    const timer = setTimeout(() => setOffer(null), OFFER_MS);
    return () => clearTimeout(timer);
  }, [offer]);

  const make = useCallback((label: string, revert: Offer["revert"]) => {
    setOffer({ label, revert });
  }, []);

  const bar = offer && (
    <div className="pointer-events-none fixed inset-x-0 bottom-[max(16px,env(safe-area-inset-bottom))] z-40 flex justify-center px-4 over-tabs:bottom-[calc(63px+env(safe-area-inset-bottom))]">
      <div
        role="status"
        className="pointer-events-auto flex w-full max-w-[440px] items-center gap-2.5 rounded-lg border border-line-strong bg-surface px-3 py-2 text-[13px] shadow-[0_6px_20px_rgba(0,0,0,.35)]"
      >
        <span className="min-w-0 flex-1 text-muted">{offer.label}</span>
        <button
          onClick={() => {
            setOffer(null);
            void offer.revert();
          }}
          className="tap flex-none rounded-[7px] border border-line px-2.5 py-1 text-[12px] text-muted hover:border-faint hover:text-text"
        >
          undo
        </button>
      </div>
    </div>
  );

  return [make, bar];
}
