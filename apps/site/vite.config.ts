import { resolve } from "node:path";

import { defineConfig } from "vite";

/**
 * A multi-page static build. No framework and no client bundle beyond a few
 * lines of inline script: a page whose entire argument is "we do less" should
 * not ship 200 kB of JavaScript to say so.
 */
export default defineConfig({
  root: __dirname,
  server: { host: "127.0.0.1", port: 5180 },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "index.html"),
        privacy: resolve(__dirname, "privacy.html"),
        terms: resolve(__dirname, "terms.html"),
        refund: resolve(__dirname, "refund.html"),
        welcome: resolve(__dirname, "welcome.html"),
      },
    },
  },
});
