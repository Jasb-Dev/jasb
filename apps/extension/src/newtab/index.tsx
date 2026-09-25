import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@jasb/ui";

import { NewTab } from "./NewTab.tsx";
import "./newtab.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from newtab.html");

createRoot(container).render(
  <StrictMode>
    <NewTab />
  </StrictMode>,
);
