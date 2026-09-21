import { useState } from "react";
import { copyText } from "../../clipboard";
import Icon from "../Icon";
import { toast } from "../ui/Toast";

/**
 * The sign-in link an agent printed, as something a thumb can use.
 *
 * Selecting a wrapped URL out of a phone terminal is close to impossible, and
 * the code the sign-in page hands back has to be pasted somewhere a phone can
 * paste: a native field, not the terminal. So both live here, under the pane,
 * until the code is sent or the bar is put away.
 */
export default function AuthLinkBar({
  url,
  onDismiss,
  onCode,
}: {
  url: string;
  onDismiss: () => void;
  /** The code the sign-in page gave back, trimmed; sent with Enter. */
  onCode: (code: string) => void;
}) {
  const [code, setCode] = useState("");
  return (
    <div className="flex flex-none flex-col gap-1.5 border-t border-line bg-surface px-2 py-1.5 font-mono text-[12px]">
      <div className="flex items-center gap-2">
        <span className="flex-none text-muted">sign-in link</span>
        {/* Opacity on text is how a token ends up below 3:1: this is the URL
            you are being asked to read off a phone. */}
        <span className="min-w-0 flex-1 truncate text-faint">{url}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-none rounded-md border border-accent px-2 py-0.5 text-accent active:bg-surface-2"
        >
          open ↗
        </a>
        {/* copyText, not navigator.clipboard: the Clipboard API only exists in
            a secure context, and this app is served over plain HTTP on the VPN. */}
        <button
          onClick={async () =>
            toast((await copyText(url)) ? "sign-in link copied" : "could not copy")
          }
          className="flex-none rounded-md border border-line px-2 py-0.5 text-muted active:bg-surface-2"
        >
          copy
        </button>
        <button
          onClick={onDismiss}
          className="tap-sq flex flex-none items-center justify-center rounded-md px-1.5 py-0.5 text-muted active:bg-surface-2"
          aria-label="dismiss sign-in link"
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = code.trim();
          if (!trimmed) return;
          onCode(trimmed);
          setCode("");
        }}
        className="flex items-center gap-2"
      >
        <input
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="paste the code here, then Send"
          aria-label="sign-in code"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          className="min-w-0 flex-1 rounded-md border border-line bg-term px-2 py-1 text-text placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <button
          type="submit"
          className="flex-none rounded-md border border-accent px-3 py-1 text-accent active:bg-surface-2"
        >
          send
        </button>
      </form>
    </div>
  );
}
