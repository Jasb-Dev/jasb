import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Two entry points, no HTML wrapper for the service worker.
 *
 * MV3 requires the worker as a bare module file at a stable path, so it is a
 * second Rollup input rather than a second page, and the manifest is written at
 * the end of the build.
 *
 * The manifest's `host_permissions` follows `VITE_JASB_SERVER`, the same value
 * the client defaults to: the store build asks for api.jasb.dev and nothing
 * else, and a local build (`VITE_JASB_SERVER=http://localhost:8787`) asks for
 * localhost instead.
 */
const server = process.env.VITE_JASB_SERVER ?? "https://api.jasb.dev";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "jasb-copy-manifest",
      closeBundle() {
        mkdirSync(resolve(__dirname, "dist"), { recursive: true });
        const manifest = JSON.parse(readFileSync(resolve(__dirname, "src/manifest.json"), "utf8"));
        manifest.host_permissions = [`${new URL(server).origin}/*`];
        writeFileSync(resolve(__dirname, "dist/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      },
    },
  ],
  build: {
    target: "chrome116",
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        newtab: resolve(__dirname, "newtab.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        // `background.js` must land at the exact path the manifest names.
        entryFileNames: (chunk) =>
          chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
