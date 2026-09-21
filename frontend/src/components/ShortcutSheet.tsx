import Sheet from "./Sheet";

/** What there is to press, where. ⌘ on a Mac is Ctrl everywhere else. */
const GROUPS: { where: string; keys: [string, string][] }[] = [
  {
    where: "anywhere",
    keys: [
      ["⌘K / Ctrl+K", "jump to or search for anything"],
      ["?", "this list"],
      ["Esc", "close a sheet, a viewer or full screen"],
    ],
  },
  {
    where: "the inbox",
    keys: [
      ["j / k", "next / previous row"],
      ["o", "open the row"],
      ["e", "done"],
      ["s", "snooze"],
    ],
  },
  {
    where: "the file tree",
    keys: [
      ["↑ / ↓", "next / previous file"],
      ["→ / ←", "open or step into / close or step out of a folder"],
      ["Enter", "open"],
      ["a letter", "the next file that starts with it"],
    ],
  },
  {
    where: "a session",
    keys: [
      ["Ctrl+Shift+C / V", "copy / paste in the terminal"],
      ["⌘Enter / Ctrl+Enter", "commit, in the commit message"],
      ["← / → on an edge", "resize the panes; Home puts it back"],
    ],
  },
];

/**
 * Every keyboard shortcut the app has, in one place (F-49).
 *
 * They had been added one screen at a time, and the only one anybody could
 * discover was the hint line on the inbox. Opened with `?` or from the palette.
 */
export default function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Keyboard shortcuts" sub="what there is to press, and where" onClose={onClose}>
      {GROUPS.map((g) => (
        <section key={g.where} className="mb-4">
          <h3 className="caps mb-1.5">{g.where}</h3>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {g.keys.map(([key, what]) => (
              <div key={key} className="contents">
                <dt className="font-mono text-[12px] whitespace-nowrap text-text">{key}</dt>
                <dd className="text-muted">{what}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </Sheet>
  );
}
