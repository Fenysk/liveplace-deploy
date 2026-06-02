import { httpRouter } from "convex/server";
import { authComponent, createAuth } from "./auth";

/**
 * Better Auth HTTP routes, served by Convex at `${CONVEX_SITE_URL}/api/auth/*`.
 * The web app proxies its catch-all `/api/auth/$` route to these (auth-flow.md).
 * CORS is restricted to the public site origin (SITE_URL) so only our frontend
 * can drive the OAuth/session endpoints.
 */
const http = httpRouter();

authComponent.registerRoutes(http, createAuth, {
  cors: {
    allowedOrigins: [process.env.SITE_URL ?? process.env.BETTER_AUTH_URL ?? ""],
  },
});

export default http;
