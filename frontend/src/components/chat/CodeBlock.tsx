import { useEffect, useState, type ReactNode } from "react";
import type { Element } from "hast";
import { copyText } from "../../clipboard";
import { highlightAs } from "../../highlight";
import Icon from "../Icon";
import { toast } from "../ui/Toast";

/**
 * The fence's language and its text, when the block is plain text inside.
 * A block that holds anything else (a find mark, say) is drawn as it is: its
 * highlighting would replace the marks.
 */
function source(pre: Element | undefined): { language: string | null; text: string } | null {
  const code = pre?.children[0];
  if (code?.type !== "element" || code.tagName !== "code") return null;
  let text = "";
  for (const child of code.children) {
    if (child.type !== "text") return null;
    text += child.value;
  }
  const cls = code.properties.className;
  const lang = Array.isArray(cls)
    ? cls.map(String).find((c) => c.startsWith("language-"))
    : undefined;
  return { language: lang ? lang.slice("language-".length) : null, text };
}

/**
 * A fenced block in an answer: highlighted when the fence names a language
 * highlight.js knows, and with its own copy button (C-30). The message's copy
 * button copies the markdown around it too, which is not what you want when
 * the block is the command to run.
 */
export default function CodeBlock({ node, children }: { node?: Element; children: ReactNode }) {
  const src = source(node);
  const [done, setDone] = useState<{ of: string; html: string } | null>(null);
  const language = src?.language;
  const text = src?.text;
  useEffect(() => {
    if (!language || text === undefined) return;
    let live = true;
    void highlightAs(language, text).then((html) => {
      if (live && html !== null) setDone({ of: text, html });
    });
    return () => {
      live = false;
    };
  }, [language, text]);
  const html = done && done.of === text ? done.html : null;

  return (
    <div className="relative mb-2 last:mb-0">
      <pre className="overflow-x-auto rounded-md border border-line bg-term p-2.5 font-mono text-[12px] text-text scheme-dark [&_code]:bg-transparent [&_code]:p-0">
        {html !== null ? <code dangerouslySetInnerHTML={{ __html: html }} /> : children}
      </pre>
      {text !== undefined && (
        <button
          type="button"
          aria-label="copy this code"
          title="copy"
          onClick={() =>
            void copyText(text.replace(/\n$/, "")).then((ok) =>
              toast(ok ? "copied" : "could not copy: the browser refused", { key: "copy" }),
            )
          }
          className="tap-hit absolute top-1.5 right-1.5 rounded bg-term p-1 text-faint hover:text-text"
        >
          <Icon name="copy" size={12} />
        </button>
      )}
    </div>
  );
}
