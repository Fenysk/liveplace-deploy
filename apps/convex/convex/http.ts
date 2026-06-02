import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

/**
 * Better Auth HTTP routes, served by Convex at `${CONVEX_SITE_URL}/api/auth/*`.
 * The Vite SPA talks to these directly — there is no app-tier server or proxy
 * (see docs/contracts/auth-flow.md). CORS is restricted to the public site
 * origin (SITE_URL) so only our frontend can drive the OAuth/session endpoints.
 */
const http = httpRouter();

authComponent.registerRoutes(http, createAuth, {
  cors: {
    allowedOrigins: [process.env.SITE_URL ?? process.env.BETTER_AUTH_URL ?? ""],
  },
});

export default http;
