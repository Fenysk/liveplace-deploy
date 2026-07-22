import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen.js";

export const router = createRouter({
  routeTree,
  // scrollRestoration deliberately NOT enabled — preserves existing parity (R3, FEN-2096).
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
