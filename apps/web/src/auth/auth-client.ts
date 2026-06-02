/**
 * Better Auth browser client for the LivePlace SPA (FEN-11 / §F1).
 *
 * Architecture note (Founding Engineer decision — see docs/contracts/auth-flow.md):
 * the web app is a plain Vite SPA with no app-tier server, so there is NO
 * catch-all `/api/auth/$` proxy route. The browser talks DIRECTLY to the auth
 * HTTP routes that Convex serves (registered in apps/convex/convex/http.ts) at
 * `${VITE_CONVEX_SITE_URL}/api/auth/*`. The `convexClient()` plugin makes the
 * Convex JWT available so Convex queries/mutations run authenticated.
 *
 * Twitch OAuth, token storage and refresh all live server-side in Convex; this
 * client never sees the Twitch access/refresh tokens (CA3).
 */
import { createAuthClient } from "better-auth/react";
import { convexClient } from "@convex-dev/better-auth/client/plugins";

const convexSiteUrl = import.meta.env.VITE_CONVEX_SITE_URL;

export const authClient = createAuthClient({
  baseURL: convexSiteUrl,
  plugins: [convexClient()],
});

export const TWITCH_PROVIDER = "twitch" as const;

/**
 * Start the Twitch OAuth flow. Redirects to Twitch consent and returns to
 * `callbackURL` once Better Auth has created/loaded the session.
 */
export async function signInWithTwitch(callbackURL = "/"): Promise<void> {
  await authClient.signIn.social({ provider: TWITCH_PROVIDER, callbackURL });
}

/**
 * Sign out, then hard-reload the page (R2b / CA6). The reload guarantees every
 * piece of in-memory auth/session/Convex state is dropped and the app
 * re-renders cleanly as an anonymous visitor.
 */
export async function signOutAndReload(): Promise<void> {
  await authClient.signOut();
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
