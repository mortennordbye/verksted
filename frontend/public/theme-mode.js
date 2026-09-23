// The light or dark mode chosen in Settings, put on <html> before first paint.
//
// A classic script in <head> rather than a module, because a module runs after
// the page may already have painted in the system's mode; and a file rather
// than inline, because the CSP allows no inline script. With nothing chosen it
// does nothing, and theme.css follows the system. The key and the values are
// the ones components/settings/Appearance.tsx writes.
try {
  const mode = localStorage.getItem("vk.theme");
  if (mode === "light" || mode === "dark") document.documentElement.dataset.theme = mode;
} catch {
  // Storage blocked: the system's mode it is.
}
