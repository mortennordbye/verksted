/**
 * The in-app path a notification opens, or "/" when it names anywhere else.
 *
 * A notification is the one surface here that opens a URL with no address bar
 * to read first, so where it lands is checked rather than trusted. The route
 * that sends one already refuses anything but a path — this is the same rule
 * at the end that reads it, because the payload arrives from the push service
 * and a worker that navigates wherever it is told is a worker worth attacking.
 *
 * `/\evil.example` is the shape that matters: URL parsing treats the backslash
 * as the second slash of an authority, so it resolves to another origin while
 * looking like a path.
 */
export function appPath(raw: unknown, origin: string): string {
  if (typeof raw !== "string" || raw === "") return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
