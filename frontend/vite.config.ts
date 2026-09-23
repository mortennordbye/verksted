import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

/** Whether a built asset is one of the material-icon-theme file icons. */
const isIcon = (file: string) => file.includes("material-icon-theme");

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Home-screen install on iOS, and the push notifications that come with
    // it. The worker itself is src/sw.ts (injectManifest rather than a
    // generated one — a generated worker cannot carry a push handler); it
    // precaches the built assets and holds the update-on-tap behaviour.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        // id pins the installed app's identity: without it the install is keyed
        // on start_url, so changing that would strand the existing home-screen
        // icon as a separate app.
        id: "/",
        name: "verksted",
        short_name: "verksted",
        description: "Self-hosted workbench for driving coding agents from a phone.",
        display: "standalone",
        // Without scope, a navigation outside it drops out of the installed
        // shell and into a browser tab.
        scope: "/",
        start_url: "/",
        // Landscape is genuinely useful for the terminal, so no orientation
        // lock — declared rather than left to chance.
        orientation: "any",
        background_color: "#0f1216",
        theme_color: "#0f1216",
        // Long-press the home-screen icon: the two screens worth reaching
        // without going through the hub first.
        shortcuts: [
          { name: "Inbox", short_name: "Inbox", url: "/runs" },
          { name: "Settings", short_name: "Settings", url: "/settings" },
        ],
        // The share sheet, on the platforms that let a web app in it: a link
        // or a paragraph lands on the inbox for the next triage turn. GET,
        // so the service worker has nothing to intercept.
        share_target: {
          action: "/share",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
        // Apart, not "any maskable" on one entry: that tells the platform the
        // same bitmap is both, so Android crops the padding-free one to fit a
        // circle and the desktop shows the padded one with its padding.
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        // Tapping a link to the app, or a notification's URL, goes to the
        // window that is already open rather than starting a second one.
        launch_handler: { client_mode: "navigate-existing" },
      },
      injectManifest: {
        // woff2 is not in workbox's default set, so the offline shell came up
        // in the platform's fallback fonts — on a phone with no tunnel, the one
        // time the shell is all there is.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // The file-type icons are 1,226 files of a kilobyte or two, and a
        // precache is fetched in full on install. Precaching them would mean
        // 1,226 requests over the tunnel to have every icon for every language
        // the theme knows, when a session shows a dozen. They are cached as
        // they are used instead — see the runtime route in sw.ts.
        globIgnores: ["**/assets/icons/**"],
      },
    }),
  ],
  build: {
    /**
     * Browsers that have light-dark(), so the minifier leaves it alone.
     *
     * Below these it rewrites every pair into two fallback variables, which
     * resolve once on <html>: the whole page follows the mode, but a
     * `scheme-dark` island inside it (the terminal) inherits the page's half
     * instead of taking its own. iOS 17.5 and Chrome 123 are both from 2024.
     */
    cssTarget: ["chrome123", "edge123", "firefox120", "safari17.5"],
    /**
     * The file-type icons are files, never data URIs.
     *
     * Vite inlines any asset under 4 KiB, and the icon theme is 1,226 SVGs of
     * about two — so the screen that draws a file tree carried every icon for
     * every language the theme knows, base64'd into its own chunk. That chunk
     * was 2.2 MB (437 KB gzipped), and it is what a notification tap has to
     * download and parse on a phone before the terminal appears.
     *
     * As files they are fetched when something actually draws one, and the
     * chunk keeps a table of URLs instead of the images themselves.
     */
    assetsInlineLimit: (filePath: string) => (isIcon(filePath) ? false : undefined),
    rollupOptions: {
      output: {
        // Their own directory, so the precache and the worker's runtime cache
        // can both tell them from the handful of assets the app shell needs.
        assetFileNames: (asset) =>
          // The source path, not the output name: the output name is "d.svg".
          isIcon(asset.originalFileNames?.[0] ?? "")
            ? "assets/icons/[name]-[hash][extname]"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
  server: {
    host: true,
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://backend:8080",
        // Forward the browser's own Host (dev is the only place the frontend
        // and the API sit on different origins), so the backend's same-origin
        // check sees Host and Origin agree. Fastify does not route on Host.
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
