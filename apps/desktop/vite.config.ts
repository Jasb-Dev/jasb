import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Builds the chrome renderer only. The main and preload processes are compiled
 * by `tsc` instead — they run in Node, not a browser, and bundling them would
 * break `better-sqlite3`'s native binding.
 */
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    target: "chrome130",
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "index.html") },
  },
});
