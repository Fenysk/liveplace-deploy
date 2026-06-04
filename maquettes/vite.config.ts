import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Self-contained LivePlace UI maquettes. Built as a static bundle so DevOps can
// serve it on test-liveplace.nas (LOCAL preview, never Coolify / liveplace.tv).
// base: "./" keeps asset paths relative so it works behind any reverse-proxy path.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
