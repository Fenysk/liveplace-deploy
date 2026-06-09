import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Minimal web app shell for LivePlace. Later UI features (canvas, gallery,
// leaderboard, profile, OBS view) are built inside this app.
//
// Tailwind v4 (@tailwindcss/vite) powers the Arcade design-system foundation
// (FEN-268, Lot 0): the design tokens are exposed to utilities through the
// `@theme` block in `src/ui/styles/index.css`, with `data-direction="fun"` as
// the active brand layer. Tokens stay the single source of truth.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: { port: 5173 },
});
