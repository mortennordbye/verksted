/** Colour class for one line of a unified diff. */
export function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-run";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-claude";
  if (line.startsWith("@@")) return "text-accent";
  if (/^(diff |index |\+\+\+|---)/.test(line)) return "text-faint";
  return "text-muted";
}

/** One file's worth of a multi-file patch. */
export interface PatchFile {
  /** Repo-relative path, spelled as the changes list spells it. */
  path: string;
  /** The file's own lines, header included. */
  lines: string[];
}

/**
 * Split a whole-range patch into its files.
 *
 * The path is taken from the `+++ b/…` line rather than the `diff --git` one:
 * a `diff --git a/x b/y` header cannot be parsed unambiguously when a path
 * contains a space, and the +++ line has exactly one path on it. A deleted file
 * has no +++ side, so it falls back to `--- a/…`.
 *
 * (The backend asks git for unquoted paths, so what is matched here is the same
 * spelling the file list uses — otherwise every non-ASCII path would arrive
 * C-quoted and match nothing.)
 */
export function splitPatch(patch: string): PatchFile[] {
  const out: PatchFile[] = [];
  if (!patch.trim()) return out;
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const lines = chunk.replace(/\n$/, "").split("\n");
    if (lines.length === 0 || !lines[0]) continue;
    const to = lines.find((l) => l.startsWith("+++ b/"));
    const from = lines.find((l) => l.startsWith("--- a/"));
    const path = to?.slice("+++ b/".length) ?? from?.slice("--- a/".length);
    // No file header at all: not a chunk this can attribute to anything, and
    // dropping it silently would lose changes from a review.
    out.push({ path: path ?? "(unknown)", lines });
  }
  return out;
}
