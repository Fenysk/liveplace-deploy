import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Minimal web app shell for LivePlace. Later UI features (canvas, gallery,
// leaderboard, profile, OBS view) are built inside this app.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
});
