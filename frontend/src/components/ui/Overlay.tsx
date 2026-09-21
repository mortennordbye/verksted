import { Dialog } from "radix-ui";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useDismissOnBack } from "../../useDismissOnBack";
import Icon from "../Icon";

/**
 * Where the box sits: a sheet rises from the bottom on a phone and centres on a
 * wide screen, a panel is a centred frame at every width, and the palette hangs
 * from the top so the list grows downward under the thumb that is typing.
 */
const PLACEMENT = {
  sheet: "items-end min-[800px]:items-center",
  panel: "items-center p-2 sm:p-4",
  top: "items-start px-4 pt-[12vh]",
} as const;

/**
 * Every modal in the app, on Radix's Dialog.
 *
 * Six overlays each drew their own backdrop and box, each declared
 * `aria-modal="true"`, and none of them kept Tab inside: a keyboard walked
 * straight out into the page behind. Only one locked the scroll, none put focus
 * anywhere on open or back where it came from on close. Radix does all four,
 * plus Escape and the click-away; what it cannot know about is Android Back,
 * which is still `useDismissOnBack`'s history entry.
 *
 * Only ever rendered while open, like the overlays it replaced, so `onClose` is
 * the one way out and a caller that is busy may decline it.
 */
export default function Overlay({
  label,
  onClose,
  placement = "panel",
  routed = false,
  ownTitle = false,
  className,
  children,
}: {
  /** The dialog's accessible name. */
  label: string;
  onClose: () => void;
  placement?: keyof typeof PLACEMENT;
  /** Open because the URL says so (`useUrlOverlay`), so Back is the URL's. */
  routed?: boolean;
  /** The children draw the name themselves, in an `OverlayTitle`. */
  ownTitle?: boolean;
  /** The box: its size, radius and padding. */
  className: string;
  children: ReactNode;
}) {
  useDismissOnBack(!routed, onClose);
  const box = useRef<HTMLDivElement>(null);
  // What had focus before, to give it back. Radix gives it to the dialog's
  // Trigger, and nothing here opens through one: a sheet is opened by state,
  // from a button, a menu row or a key. Taken in a layout effect, which runs
  // before Radix's own mount effect moves focus into the box.
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
  }, []);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        {/* The flex frame is what places the box; Radix's own overlay above is
            only the dimmed backdrop, so a click on the frame is a click away. */}
        <div
          className={`pointer-events-none fixed inset-0 z-40 flex justify-center ${PLACEMENT[placement]}`}
        >
          <Dialog.Content
            ref={box}
            aria-describedby={undefined}
            // Focus the box itself, not its first field. A field focused on open
            // summons a phone's keyboard, which shoves a sheet off the top of
            // the screen before it has been read; a caller that wants a field
            // focused (the palette, a desktop sheet) does it itself, and that
            // is left alone.
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              if (!box.current?.contains(document.activeElement)) box.current?.focus();
            }}
            onCloseAutoFocus={(e) => {
              e.preventDefault();
              if (opener.current instanceof HTMLElement && opener.current.isConnected) {
                opener.current.focus();
              }
            }}
            className={`pointer-events-auto flex flex-col border border-line bg-surface outline-none ${className}`}
          >
            {!ownTitle && <Dialog.Title className="sr-only">{label}</Dialog.Title>}
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A title the overlay shows, which is then also its accessible name. */
export const OverlayTitle = Dialog.Title;

/**
 * The strip along the top of a full-screen viewer: what is open, whatever the
 * viewer offers for it, and the way out. The code, file and document viewers
 * each drew this row by hand.
 */
export function OverlayHeader({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  /** Controls between the title and the close button, pushed to the right. */
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5 font-mono text-[12px] text-muted">
      <span className="flex min-w-0 items-center gap-2 truncate">{title}</span>
      <div className="ml-auto flex flex-none items-center">
        {children}
        {/* The way out of a full-screen overlay on a phone, so it gets the 44px
            the rest of the app's icon controls have. */}
        <button
          onClick={onClose}
          aria-label="close"
          className="tap-sq flex flex-none items-center justify-center px-2 text-faint hover:text-text"
        >
          <Icon name="close" size={16} />
        </button>
      </div>
    </div>
  );
}
