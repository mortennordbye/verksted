import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Home-screen install on iOS. The service worker only precaches the built
    // assets; navigations fall back to index.html but /api (REST + websockets)
    // must always hit the network.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["apple-touch-icon.png"],
      manifest: {
        name: "verksted",
        short_name: "verksted",
        description: "Self-hosted agent workbench",
        display: "standalone",
        background_color: "#0f1216",
        theme_color: "#0f1216",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//],
        // The hljs + icon chunks exceed the 2 MiB precache default.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: "http://backend:8080",
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
