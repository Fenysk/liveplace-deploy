import { I18nProvider } from "@canvas/i18n/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "./auth/ConvexAuthProvider.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Router } from "./router.js";
import { i18n } from "./i18n.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <ConvexAuthProvider>
        <ErrorBoundary>
          <Router />
        </ErrorBoundary>
      </ConvexAuthProvider>
    </I18nProvider>
  </StrictMode>,
);
