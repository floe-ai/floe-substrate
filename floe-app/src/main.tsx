import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { installHtmlPreviewFramePolicy } from "./runtime/htmlPreviewPolicy.ts";

installHtmlPreviewFramePolicy();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("No #root element found");

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
);
