/**
 * Node entry point.
 *
 * The app itself is a plain Hono instance, so the same `createApp()` runs
 * unchanged on Cloudflare Workers (`export default app`), Deno, or Bun — this
 * file only supplies the Node adapter.
 */

import { serve } from "@hono/node-server";

import { createApp } from "./app.ts";
import { describeConfig, loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp({ config });

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`jasb server  http://${config.host}:${info.port}`);
  console.log(`  ${describeConfig(config)}`);
  if (!config.braveApiKey && !config.searxngUrl) {
    console.log(
      "  no general search source configured — set JASB_BRAVE_API_KEY or JASB_SEARXNG_URL",
    );
  }
});
