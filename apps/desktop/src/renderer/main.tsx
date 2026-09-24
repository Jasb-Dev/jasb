import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@jasb/ui";
import "./desktop.css";

import { Shell } from "./Shell.tsx";

// The tab strip reserves space for the traffic lights only on macOS, where the
// native title bar is hidden. The renderer has no Node access, so the platform
// comes from the user agent rather than from `process`.
const isMac = /Mac/i.test(navigator.userAgent);
document.documentElement.dataset.platform = isMac ? "mac" : "other";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
