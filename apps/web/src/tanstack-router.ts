import { createRouter } from "@tanstack/react-router";
import { RouteErrorFallback } from "./ErrorBoundary.js";
import { routeTree } from "./routeTree.gen.js";

export const router = createRouter({
  routeTree,
  // Route-scoped error surface: a render throw inside a route no longer
  // unmounts the whole tree — Retry resets the boundary + invalidates (FEN-2127).
  defaultErrorComponent: RouteErrorFallback,
  // Preload route chunks on link hover — pairs with autoCodeSplitting in vite.config.ts.
  defaultPreload: "intent",
  // Pending component is intentionally null: auto-split chunks are tiny (<50 ms on a decent
  // connection) and the 1000 ms defaultPendingMs grace period means this is never seen.
  defaultPendingComponent: () => null,
  // scrollRestoration deliberately NOT enabled — preserves existing parity (R3, FEN-2096).
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
