/**
 * Syntax highlighting for the file viewer, fetched the first time a file is
 * opened rather than with the screen that might open one.
 *
 * highlight.js's common bundle is a third of a megabyte of grammars, and it was
 * a static import in `Session.tsx` — so a notification tapped on a phone
 * downloaded and parsed every grammar it ships before the terminal appeared,
 * for a viewer most visits never open. Loaded here on demand, and kept: the
 * second file is highlighted without another request.
 *
 * The theme travels with it. It styles nothing but the `hljs` spans this
 * produces, so there is no moment where the page is missing its own CSS.
 */
type Hljs = typeof import("highlight.js/lib/common").default;

let loading: Promise<Hljs> | null = null;

function load(): Promise<Hljs> {
  loading ??= Promise.all([
    import("highlight.js/lib/common"),
    import("highlight.js/styles/github-dark-dimmed.css"),
  ]).then(([mod]) => mod.default);
  return loading;
}

/**
 * The file as highlighted HTML, or null when nothing here knows the language.
 *
 * hljs escapes the source and produces span tags with classes, which is why the
 * caller may set it as HTML.
 */
export async function highlight(path: string, content: string): Promise<string | null> {
  // The extension, via hljs's own alias table: ts, py and yml all resolve.
  const name = path.split("/").at(-1)!.toLowerCase();
  return highlightAs(name.split(".").at(-1)!, content);
}

/** The same, for a language named outright, as a fenced block in chat names it. */
export async function highlightAs(language: string, content: string): Promise<string | null> {
  const hljs = await load();
  return hljs.getLanguage(language) ? hljs.highlight(content, { language }).value : null;
}
