/**
 * HomeView — entry point for the home route (FEN-433 / G6 / FEN-611).
 *
 * Renders the full G6 live-discovery page: topbar, hero with "Voir la galerie"
 * CTA (AC5), live-canvas rail, and all-channels grid. The LiveDiscovery
 * component handles the Convex subscription and the view-model derivation.
 *
 * Authenticated users who already have a personal canvas are redirected by
 * `HomeRoute` (router.tsx) before this component ever renders.
 */
import { LiveDiscovery } from "./LiveDiscovery.js";

export function HomeView(): React.ReactElement {
  return <LiveDiscovery />;
}
