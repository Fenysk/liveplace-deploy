import { I18nProvider } from "@canvas/i18n/react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "./auth/ConvexAuthProvider.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { i18n } from "./i18n.js";
import { router } from "./tanstack-router.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <ConvexAuthProvider>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
      </ConvexAuthProvider>
    </I18nProvider>
  </StrictMode>,
);
