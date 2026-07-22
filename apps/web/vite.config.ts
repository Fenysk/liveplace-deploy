import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import { defineConfig, type Plugin } from "vite";

// Minimal web app shell for LivePlace. Later UI features (canvas, gallery,
// leaderboard, profile, OBS view) are built inside this app.
//
// Tailwind v4 (@tailwindcss/vite) powers the Arcade design-system foundation
// (FEN-268, Lot 0): the design tokens are exposed to utilities through the
// `@theme` block in `src/ui/styles/index.css`, with `data-direction="fun"` as
// the active brand layer. Tokens stay the single source of truth.

// FEN-665: VITE_CONVEX_URL is INLINED at build time (Dockerfile build arg). When
// it is empty the SPA still builds, but `new ConvexReactClient("")` throws at
// module load ("Provided address was not an absolute URL") → React never mounts
// → a fully white production page that HTTP-200 health checks happily pass. That
// regression reached prod once (FEN-617 bundle index-DimhpE-O.js). Make the build
// FAIL LOUDLY instead of shipping a broken artifact: a misconfigured build env can
// no longer produce a deployable white page.
function requireConvexBuildEnv(): Plugin {
  return {
    name: "liveplace-require-convex-build-env",
    apply: "build",
    config() {
      const url = process.env.VITE_CONVEX_URL ?? "";
      if (!/^https?:\/\/.+/i.test(url)) {
        throw new Error(
          `[build] VITE_CONVEX_URL is ${url === "" ? "empty" : `"${url}" (not an absolute http(s) URL)`}. ` +
            `Refusing to build — ConvexReactClient(${JSON.stringify(url)}) throws at load and the SPA white-pages. ` +
            `Pass it as a Docker build arg, e.g. VITE_CONVEX_URL=https://<host>/convex (FEN-665).`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    // Route tree is generated before bundling; scrollRestoration disabled (parity, R3 guard).
    TanStackRouterVite({ routesDirectory: "./src/routes", generatedRouteTree: "./src/routeTree.gen.ts" }),
    requireConvexBuildEnv(),
    tailwindcss(),
    react(),
  ],
  server: { port: 5173 },
});
