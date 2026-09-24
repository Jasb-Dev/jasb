import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Imports the token, base and component layers in that order.
import "@jasb/ui";

import { App } from "./App.tsx";
import { Bench } from "./Bench.tsx";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

// One extra route, and only one: the Phase 0 blind test lives at /bench. A
// router would be four dependencies for a two-page app.
const Page = window.location.pathname.startsWith("/bench") ? Bench : App;

createRoot(container).render(
  <StrictMode>
    <Page />
  </StrictMode>,
);
