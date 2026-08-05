import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

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
      injectManifest: {
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
        // Forward the browser's own Host (dev is the only place the frontend
        // and the API sit on different origins), so the backend's same-origin
        // check sees Host and Origin agree. Fastify does not route on Host.
        changeOrigin: false,
        ws: true,
      },
    },
  },
});
