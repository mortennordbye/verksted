/**
 * A size in bytes as a person reads it: "812 B", "4.2 MB", "31 GB".
 *
 * Three screens each had their own: the documents in kB/MB with a decimal
 * under ten, the bench's disk and memory in "G" to one place, the backups'
 * free space in "G" to none. One rule for all of them.
 */
export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
