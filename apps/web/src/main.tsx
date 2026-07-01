import { I18nProvider } from "@canvas/i18n/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexAuthProvider } from "./auth/ConvexAuthProvider.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Router } from "./router.js";
import { i18n } from "./i18n.js";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// Provider nesting (FEN-1515): the ErrorBoundary wraps ConvexAuthProvider, NOT
// the other way around. A React error boundary can only catch throws from its
// DESCENDANTS, so with the auth provider on the outside any synchronous throw
// from the Convex/Better-Auth provider layer (e.g. while it processes a
// freshly-minted session/JWT on a brand-new account's first Twitch login)
// escaped the boundary, unmounted the whole tree, and left a WHITE VOID that
// replayed on every reload (the session cookie re-triggered the same throw).
// The boundary stays UNDER I18nProvider because its fallback calls useTranslate
// (useI18n throws without a provider above it), and the error-screen keys exist
// in both catalogs — so the fallback can render for any provider-or-render throw
// instead of a blank page.
createRoot(root).render(
  <StrictMode>
    <I18nProvider i18n={i18n}>
      <ErrorBoundary>
        <ConvexAuthProvider>
          <Router />
        </ConvexAuthProvider>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
