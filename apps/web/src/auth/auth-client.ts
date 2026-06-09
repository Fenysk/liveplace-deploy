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
 * Resolve the current Convex JWT, or `null` when signed out / not yet issued.
 *
 * This is the SAME token `ConvexBetterAuthProvider` hands to Convex queries
 * (`authClient.convex.token()`, added by the `convexClient()` plugin), so the
 * gateway — which verifies the JWT offline against Convex JWKS (same issuer /
 * audience) — accepts it for an authenticated WebSocket. The canvas net client
 * appends it as `?token=` so a signed-in viewer's socket carries identity and
 * the gateway can resolve `userId` (and thus a per-user gauge). Tokenless ⇒
 * anonymous read-only (FEN-184). Never throws — a failure degrades to anonymous.
 */
export async function fetchConvexToken(): Promise<string | null> {
  try {
    const { data } = await (
      authClient as unknown as {
        convex: { token: (opts?: unknown) => Promise<{ data?: { token?: string | null } }> };
      }
    ).convex.token({ fetchOptions: { throw: false } });
    return data?.token ?? null;
  } catch {
    return null;
  }
}

/**
 * Start the Twitch OAuth flow. Redirects to Twitch consent and returns to
 * `callbackURL` once Better Auth has created/loaded the session.
 */
export async function signInWithTwitch(callbackURL = "/"): Promise<void> {
  await authClient.signIn.social({ provider: TWITCH_PROVIDER, callbackURL });
}

/**
 * Sign out without a hard reload (FEN-115 / Lot B).
 *
 * The earlier R2b/CA6 implementation force-reloaded the page so every piece of
 * in-memory auth/session/Convex state was dropped. That is no longer needed:
 * Better Auth's `useSession()` is reactive, so the session flips to `null` in
 * place and `ConvexBetterAuthProvider` drops the JWT, returning the app to the
 * anonymous (read-only) view-first state without a full navigation. Placement
 * stays server-authoritative, so a stale client could never place after
 * sign-out regardless of the reload. Removing the reload keeps the canvas
 * WebSocket and the live view alive — consistent with the view-first model.
 */
export async function signOut(): Promise<void> {
  await authClient.signOut();
}

/**
 * @deprecated Use {@link signOut}. Retained as a thin alias for any caller that
 * still imports the reload-based name; it no longer reloads (FEN-115).
 */
export const signOutAndReload = signOut;
