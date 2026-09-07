import { useState } from "react";
import { createPortal } from "react-dom";
import { defaultUrlTransform } from "react-markdown";
import { Link } from "react-router";
import DocViewer from "../DocViewer";

/**
 * Citations: `[doc:<path>]`, `[feed:<id>]`, `[loop:<slug>]`, `[mail:<uid>]`,
 * `[session:<id>]`, `[pr:<project>#<n>]`, as the persona asks for them, turned
 * into chips that open the thing.
 *
 * Done as a text pass before markdown rather than a plugin: the bracket form
 * is not markdown, and rewriting it into a link with a `vk:` scheme lets the
 * ordinary link renderer decide what to draw. A bracket naming a kind this
 * does not know is left as written.
 *
 * What follows the colon may hold spaces, because a document is cited by its
 * path on the share and a folder on a NAS is called "Kontrakt Nimtech". The
 * six kinds are the whole guard against matching ordinary prose, and the id
 * is percent-encoded on its way into the link: a markdown destination ends at
 * the first space.
 */
const CITE_RE = /\[(doc|feed|loop|mail|session|pr):([^\]\n]+)\]/g;

export function cite(text: string): string {
  return text.replace(
    CITE_RE,
    (_, kind: string, id: string) => `[${kind}:${id}](vk:${kind}/${encodeURIComponent(id)})`,
  );
}

/**
 * The same brackets, taken back out.
 *
 * A chip is something to tap, which is nothing at all to a voice: read aloud,
 * a cited answer said "per the signed contract doc documents Kontrakt nimtech
 * dash 21 dot 06 dot 25 dot p d f". The sentence in front of it already says
 * what it rests on, so the citation simply goes.
 */
export function uncite(text: string): string {
  return text.replace(CITE_RE, "").replace(/ +([.,;:!?])/g, "$1");
}

/**
 * The transform that lets those links survive to the renderer.
 *
 * react-markdown sanitises every href, and `vk:` is not one of the schemes it
 * keeps — so the link `cite` just wrote arrived at the element map as an empty
 * string, missed the chip branch, and drew a plain anchor pointing nowhere.
 * Every citation in the app opened a blank tab. `vk:` is ours, written two
 * functions above this and read by `citePath` below; everything else is
 * sanitised exactly as before.
 */
export function citeUrl(url: string): string {
  return url.startsWith("vk:") ? url : defaultUrlTransform(url);
}

/**
 * Where a chip goes: a route for everything that is a screen, and a path on
 * the share for a document, which opens where it was cited rather than
 * sending the reader off to the Documents screen to find it again.
 */
export function citePath(href: string): { to?: string; doc?: string; label: string } | null {
  const m = /^vk:(doc|feed|loop|mail|session|pr)\/(.+)$/.exec(href);
  if (!m) return null;
  const [, kind] = m;
  const id = decodeURIComponent(m[2]);
  switch (kind) {
    case "doc":
      return { doc: id, label: id.split("/").at(-1) ?? id };
    case "feed":
      return { to: `/runs#${id}`, label: id.split(":").slice(0, 2).join(":") };
    case "loop":
      return { to: "/runs", label: id };
    case "mail":
      return { to: `/runs#mail:${id}`, label: `mail ${id}` };
    case "session":
      return { to: `/s/${id}`, label: id };
    case "pr": {
      const [project, number] = id.split("#");
      return { to: `/p/${project}?side=prs`, label: number ? `${project} #${number}` : project };
    }
    default:
      return null;
  }
}

const CHIP =
  "mx-0.5 inline-flex max-w-[14rem] items-center rounded-full border border-line bg-surface-2 px-1.5 py-px align-[1px] font-mono text-[10.5px] text-muted no-underline hover:border-accent hover:text-accent";

export function Cite({ href }: { href: string }) {
  const c = citePath(href);
  if (!c) return null;
  if (c.doc) return <DocCite path={c.doc} label={c.label} />;
  return (
    <Link to={c.to ?? "/"} className={CHIP}>
      <span className="truncate">{c.label}</span>
    </Link>
  );
}

/**
 * A cited document, read in the overlay without leaving the conversation.
 *
 * The overlay goes to the body rather than where the chip sits: the chip is
 * inside a rendered paragraph, and a full-screen dialog does not belong in the
 * middle of a sentence.
 */
function DocCite({ path, label }: { path: string; label: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={`tap ${CHIP}`}>
        <span className="truncate">{label}</span>
      </button>
      {open &&
        createPortal(
          <DocViewer path={path} initialFind="" onClose={() => setOpen(false)} />,
          document.body,
        )}
    </>
  );
}
