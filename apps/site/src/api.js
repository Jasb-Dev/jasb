/**
 * Where the API lives: api.jasb.dev in production, a local server during
 * development, or whatever `VITE_JASB_API` names at build time.
 */
export const API =
  import.meta.env.VITE_JASB_API ??
  (location.hostname === "localhost" || location.hostname === "127.0.0.1"
    ? "http://127.0.0.1:8787"
    : "https://api.jasb.dev");
