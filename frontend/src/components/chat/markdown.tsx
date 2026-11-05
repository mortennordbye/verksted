import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Cite } from "./cite";
import CodeBlock from "./CodeBlock";

/**
 * The dialect. Plain markdown has no tables, and an agent asked to compare
 * three offers or four PRs writes one every time: a grid of pipes and dashes
 * down the middle of an answer read on a phone. This is passed at every call
 * site rather than being the renderer's default, because react-markdown has
 * no default to set.
 */
export const REMARK = [remarkGfm];

/**
 * How an agent writes: headings, bold, bullets, and a great deal of `code`.
 * Left as source it is worse than the terminal it replaces — asterisks and
 * hashes through the middle of every sentence.
 *
 * react-markdown builds React elements rather than HTML, so nothing here can
 * inject markup, and no raw-HTML plugin is added. The element map is the
 * styling: this app has no typography plugin, and a paragraph with browser
 * defaults looks broken.
 */
export const MD: Components = {
  p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
  h1: ({ children }) => <h3 className="mt-5 mb-2 text-h1 font-semibold first:mt-0">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-h2 font-semibold first:mt-0">{children}</h3>,
  h3: ({ children }) => (
    <h3 className="mt-4 mb-1.5 text-h3 font-semibold first:mt-0">{children}</h3>
  ),
  ul: ({ children }) => <ul className="mb-3 list-disc pl-5 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal pl-5 last:mb-0">{children}</ol>,
  li: ({ children }) => <li className="mb-1">{children}</li>,
  code: ({ children }) => (
    <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-code">{children}</code>
  ),
  // A fenced block: the <code> above is still inside it, so the padding and
  // background come off there to avoid a box in a box.
  pre: ({ node, children }) => <CodeBlock node={node}>{children}</CodeBlock>,
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
  // Never a remote fetch. An `![](…)` in a reply is not a picture anybody asked
  // for: the images in this app arrive as entry attachments and are drawn by
  // the bubble, so the only thing that writes one into the markdown is a model
  // repeating text it read somewhere. Rendering it would issue the request on
  // sight, with whatever the model put in the query string, before anyone had
  // the chance to not tap it. The alt text stays, so nothing vanishes silently.
  img: ({ alt }) => <span className="text-faint italic">{alt || "image"}</span>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-line pl-3 text-muted last:mb-0">
      {children}
    </blockquote>
  ),
  // A table is the one block that will not fit: four columns of PR names on a
  // phone are wider than the screen whatever is done to them, so it scrolls in
  // its own box rather than pushing the whole conversation sideways.
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto rounded-lg border border-line last:mb-0">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-line bg-surface-2 px-2.5 py-1.5 text-left font-semibold whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-t border-line/60 px-2.5 py-1.5 align-top text-muted">{children}</td>
  ),
  del: ({ children }) => <del className="text-faint line-through">{children}</del>,
};
