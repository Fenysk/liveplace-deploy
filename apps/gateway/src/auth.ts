/**
 * Socket authentication (CA3 / CA5). The gateway verifies the JWT a client
 * presents at connect time, OFFLINE, against Convex's JWKS — which jose fetches
 * once and caches/refreshes, so a verification never blocks on the network in
 * the hot path. An invalid, malformed, or expired token throws and the upgrade
 * is refused (`401`).
 *
 * A connect with **no token at all** is *not* an error: it is admitted as an
 * anonymous, read-only visitor (`userId = null`) so the public canvas and the
 * OBS browser source can watch the live canvas without signing in (FEN-53; see
 * docs/contracts/auth-flow.md). The two cases are deliberately distinct —
 * tokenless ⇒ anonymous, present-but-invalid ⇒ reject — so a bad token never
 * silently downgrades to anonymous. Anonymous sockets are refused `place`
 * server-side (gateway.ts), so read-only is enforced, not merely advertised.
 *
 * Three modes, chosen by config:
 *   - jwksUrl set      → production: verify RS/ES signatures against Convex JWKS.
 *   - devSecret set    → local dev: verify HS256 against a shared secret.
 *   - disabled         → local smoke only: accept everyone as "anon".
 */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { AuthConfig } from "./config";

// Re-exported so consumers/tests can import the auth config type from the auth module.
export type { AuthConfig } from "./config";

export interface AuthedUser {
  /** JWT `sub` of the signed-in user, or `null` for an anonymous read-only visitor. */
  userId: string | null;
}

/** The result of a tokenless upgrade: an anonymous, read-only viewer. */
const ANONYMOUS: AuthedUser = { userId: null };

export class AuthError extends Error {}

export interface SocketAuthenticator {
  /**
   * Resolve the user for a connect attempt:
   *   - no token presented           → anonymous read-only viewer (`{ userId: null }`);
   *   - a token that fails to verify  → throws `AuthError` (upgrade refused, `401`);
   *   - a valid token                → `{ userId: sub }`.
   */
  authenticate(token: string | undefined): Promise<AuthedUser>;
}

export function createAuthenticator(cfg: AuthConfig): SocketAuthenticator {
  if (cfg.disabled) {
    console.warn(
      "[auth] GATEWAY_AUTH_DISABLED is set — every socket is accepted as anonymous. " +
        "This must never be used outside local smoke tests.",
    );
    return { authenticate: async () => ({ userId: "anon" }) };
  }

  const verifyOpts = { issuer: cfg.issuer, audience: cfg.audience };

  if (cfg.jwksUrl) {
    const jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(cfg.jwksUrl));
    return {
      authenticate: (token) => authenticateOrAnonymous(token, jwks, verifyOpts),
    };
  }

  if (cfg.devSecret) {
    const key = new TextEncoder().encode(cfg.devSecret);
    return {
      authenticate: (token) => authenticateOrAnonymous(token, key, verifyOpts),
    };
  }

  throw new Error(
    "no auth configured: set CONVEX_JWKS_URL (prod), GATEWAY_DEV_JWT_SECRET (dev), " +
      "or GATEWAY_AUTH_DISABLED=1 (local smoke only)",
  );
}

/**
 * A tokenless upgrade is an anonymous read-only viewer (CA5); any token that is
 * actually presented must verify — a present-but-invalid token is refused, never
 * downgraded to anonymous.
 */
async function authenticateOrAnonymous(
  token: string | undefined,
  key: JWTVerifyGetKey | Uint8Array,
  opts: { issuer?: string; audience?: string },
): Promise<AuthedUser> {
  if (!token) return ANONYMOUS;
  return verify(token, key, opts);
}

async function verify(
  token: string,
  key: JWTVerifyGetKey | Uint8Array,
  opts: { issuer?: string; audience?: string },
): Promise<AuthedUser> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, key as JWTVerifyGetKey, opts));
  } catch (err) {
    throw new AuthError(`token verification failed: ${(err as Error).message}`);
  }
  const userId = typeof payload.sub === "string" ? payload.sub : undefined;
  if (!userId) throw new AuthError("token has no subject (sub)");
  return { userId };
}
