import { Link } from "react-router";

/**
 * Citations: `[feed:<id>]`, `[loop:<slug>]`, `[mail:<uid>]`, `[session:<id>]`,
 * `[pr:<project>#<n>]`, as the persona asks for them, turned into chips that
 * open the thing.
 *
 * Done as a text pass before markdown rather than a plugin: the bracket form
 * is not markdown, and rewriting it into a link with a `vk:` scheme lets the
 * ordinary link renderer decide what to draw. A bracket naming a kind this
 * does not know is left as written.
 */
const CITE_RE = /\[(feed|loop|mail|session|pr):([^\]\s]+)\]/g;

export function cite(text: string): string {
  return text.replace(
    CITE_RE,
    (_, kind: string, id: string) => `[${kind}:${id}](vk:${kind}/${id})`,
  );
}

/** Where a chip goes. */
export function citePath(href: string): { to: string; label: string } | null {
  const m = /^vk:(feed|loop|mail|session|pr)\/(.+)$/.exec(href);
  if (!m) return null;
  const [, kind, id] = m;
  switch (kind) {
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

export function Cite({ href }: { href: string }) {
  const c = citePath(href);
  if (!c) return null;
  return (
    <Link
      to={c.to}
      className="mx-0.5 inline-flex max-w-[14rem] items-center rounded-full border border-line bg-surface-2 px-1.5 py-px align-[1px] font-mono text-[10.5px] text-muted no-underline hover:border-accent hover:text-accent"
    >
      <span className="truncate">{c.label}</span>
    </Link>
  );
}
