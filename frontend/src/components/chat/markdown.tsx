import type { Components } from "react-markdown";
import { Cite } from "./cite";

/**
 * How an agent writes: headings, bold, bullets, and a great deal of `code`.
 * Left as source it is worse than the terminal it replaces — asterisks and
 * hashes through the middle of every sentence.
 *
 * react-markdown builds React elements rather than HTML, so nothing here can
 * inject markup, and no raw-HTML plugin is added. The element map is the
 * styling: this app has no typography plugin, and a paragraph with browser
 * defaults inside a chat bubble looks broken.
 */
export const MD: Components = {
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => <h3 className="mt-3 mb-1.5 font-semibold first:mt-0">{children}</h3>,
  ul: ({ children }) => <ul className="mb-2 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[12.5px]">{children}</code>
  ),
  // A fenced block: the <code> above is still inside it, so the padding and
  // background come off here to avoid a box in a box.
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md border border-line bg-term p-2.5 font-mono text-[12px] last:mb-0 [&_code]:bg-transparent [&_code]:p-0">
      {children}
    </pre>
  ),
  // A citation the persona wrote as [feed:…] arrives here as a vk: link (see
  // cite.tsx) and is drawn as a chip that opens the thing; any other link is
  // a link.
  a: ({ href, children }) =>
    href?.startsWith("vk:") ? (
      <Cite href={href} />
    ) : (
      <a href={href} target="_blank" rel="noreferrer" className="text-accent underline">
        {children}
      </a>
    ),
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-line pl-3 text-muted last:mb-0">
      {children}
    </blockquote>
  ),
};
