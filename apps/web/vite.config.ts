import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // Bind IPv4 explicitly. Vite's default binds `::1` only on some systems,
  // and a browser that resolves `localhost` to 127.0.0.1 then gets a connection
  // refused — a confusing first five minutes for anyone cloning this.
  server: { host: "127.0.0.1", port: 5173, strictPort: false },
  build: { target: "es2022", sourcemap: true },
  // /bench is client-routed, so the dev server must serve index.html for it
  // rather than 404ing on a path that has no file behind it.
  appType: "spa",
});
