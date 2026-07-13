// Material Icon Theme lookups: filename/dirname -> bundled SVG url.
import manifestJson from "material-icon-theme/dist/material-icons.json";

const manifest = manifestJson as {
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
};

// node_modules lives at the workspace root, one level above the vite root.
const icons = import.meta.glob("../../node_modules/material-icon-theme/icons/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function url(iconName: string, fallback: string): string {
  const at = (n: string) => icons[`../../node_modules/material-icon-theme/icons/${n}.svg`];
  return at(iconName) ?? at(fallback);
}

export function fileIcon(name: string): string {
  const lower = name.toLowerCase();
  const byName = manifest.fileNames[lower];
  if (byName) return url(byName, manifest.file);
  // Longest compound extension wins ("test.ts" before "ts").
  const parts = lower.split(".");
  for (let i = 1; i < parts.length; i++) {
    const icon = manifest.fileExtensions[parts.slice(i).join(".")];
    if (icon) return url(icon, manifest.file);
  }
  return url(manifest.file, manifest.file);
}

export function folderIcon(name: string, open: boolean): string {
  const lower = name.toLowerCase();
  const icon = open
    ? (manifest.folderNamesExpanded[lower] ?? manifest.folderExpanded)
    : (manifest.folderNames[lower] ?? manifest.folder);
  return url(icon, open ? manifest.folderExpanded : manifest.folder);
}
