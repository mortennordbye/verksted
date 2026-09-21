import { copyText } from "../../clipboard";
import Icon from "../Icon";
import { toast } from "../ui/Toast";

/**
 * Copy what was said. Always drawn, faintly: a phone has no hover to reveal it
 * on, and selecting a whole reply by dragging handles through rendered
 * markdown is the thing this is here to replace. The text copied is the
 * markdown as written, which is what pastes well into an issue or a mail.
 */
export default function CopyButton({ text, className = "" }: { text: string; className?: string }) {
  return (
    <button
      type="button"
      aria-label="copy this message"
      title="copy"
      onClick={() =>
        void copyText(text).then((ok) =>
          toast(ok ? "copied" : "could not copy: the browser refused", { key: "copy" }),
        )
      }
      className={`tap-hit flex-none rounded p-0.5 text-faint hover:text-text ${className}`}
    >
      <Icon name="copy" size={12} />
    </button>
  );
}
