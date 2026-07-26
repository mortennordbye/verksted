/** Colour class for one line of a unified diff. */
export function diffLineClass(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-run";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-claude";
  if (line.startsWith("@@")) return "text-accent";
  if (/^(diff |index |\+\+\+|---)/.test(line)) return "text-faint";
  return "text-muted";
}
