import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// In development the API runs on :4000 (node server); Vite proxies /api to it.
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the built app works from any folder, so it can be mounted anywhere.
  base: "./",
  build: {
    rollupOptions: {
      // Two pages: the app itself and an example of embedding it with a plugin.
      input: { main: resolve(__dirname, "index.html"), host: resolve(__dirname, "host.html") },
    },
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: { "/api": "http://127.0.0.1:4000" },
  },
});
