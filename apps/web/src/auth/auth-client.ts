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

export interface SignInWithTwitchOpts {
  callbackURL?: string;
  errorCallbackURL?: string;
}

/**
 * Start the Twitch OAuth flow. Redirects to Twitch consent and returns to
 * `callbackURL` once Better Auth has created/loaded the session. Sends the
 * viewer to `errorCallbackURL` (AC10) on OAuth error when provided.
 *
 * Accepts a bare `callbackURL` string (backward-compat) or an options object
 * with both `callbackURL` and `errorCallbackURL`. No-op when a session is
 * already active (AC9).
 */
export async function signInWithTwitch(
  optsOrCallbackUrl?: string | SignInWithTwitchOpts,
): Promise<void> {
  const opts: SignInWithTwitchOpts =
    typeof optsOrCallbackUrl === "string"
      ? { callbackURL: optsOrCallbackUrl }
      : optsOrCallbackUrl ?? {};

  // AC9: no-op if a session is already active.
  try {
    const { data: session } = await authClient.getSession();
    if (session) return;
  } catch {
    // getSession failure → proceed to OAuth (safe fallback).
  }

  await authClient.signIn.social({
    provider: TWITCH_PROVIDER,
    callbackURL: opts.callbackURL ?? "/",
    ...(opts.errorCallbackURL != null ? { errorCallbackURL: opts.errorCallbackURL } : {}),
  });
}

// ── Auth-session hint ────────────────────────────────────────────────────────
//
// A localStorage flag that records whether the current browser has a session.
// Written whenever the session settles; read at component mount to avoid the
// FOUC (FEN-910): if the hint says "was authed", the auth slot shows a loading
// skeleton rather than the login CTA while Better Auth resolves the session.
//
// This is a best-effort optimistic signal — a stale hint (e.g. expired server
// token) simply means the slot briefly shows the skeleton before flipping to
// the login CTA (AC4). It never hides the CTA permanently.

const AUTH_HINT_KEY = "lp-was-authed";

/** True when a positive auth hint is recorded in localStorage. */
export function getAuthHint(): boolean {
  try {
    return localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Record (or clear) the hint. Call whenever session state settles. */
export function setAuthHint(authed: boolean): void {
  try {
    if (authed) {
      localStorage.setItem(AUTH_HINT_KEY, "1");
    } else {
      localStorage.removeItem(AUTH_HINT_KEY);
    }
  } catch {
    // Ignore storage errors (private/incognito browsing, quota exceeded, etc.).
  }
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
 *
 * Clears the auth hint eagerly so the next page load does not show a skeleton
 * for a signed-out user (FEN-910).
 */
export async function signOut(): Promise<void> {
  setAuthHint(false);
  await authClient.signOut();
}

