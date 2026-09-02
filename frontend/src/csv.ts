/**
 * A delimited export, back into the grid it left.
 *
 * The share collects the CSVs a bank and a spreadsheet write, so quotes,
 * embedded commas and newlines inside a cell all turn up, and the delimiter is
 * whatever the machine that wrote the file uses — Excel in a Norwegian locale
 * writes semicolons. Both are read here; nothing is guessed about types, since
 * a table of strings is what is being drawn.
 */

/** Whichever of the three separates the most fields on the first line. */
export function delimiterOf(text: string): string {
  const head = text.split("\n", 1)[0] ?? "";
  const count = (d: string) => head.split(d).length;
  return [",", ";", "\t"].reduce((best, d) => (count(d) > count(best) ? d : best), ",");
}

export interface Csv {
  rows: string[][];
  /** True when rows were dropped: a bank export is tens of thousands of lines. */
  truncated: boolean;
}

export function parseCsv(text: string, maxRows = 500): Csv {
  const delimiter = delimiterOf(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    // A trailing newline, or a blank line between blocks, is not a row.
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      // "" inside a quoted cell is one literal quote.
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === "") quoted = true;
    else if (c === delimiter) endCell();
    else if (c === "\n") {
      endRow();
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1 };
    } else if (c !== "\r") cell += c;
  }
  if (cell !== "" || row.length > 0) endRow();
  return { rows, truncated: false };
}
