/**
 * Socket authentication (CA3). The gateway verifies the JWT a client presents
 * at connect time, OFFLINE, against Convex's JWKS — which jose fetches once and
 * caches/refreshes, so a verification never blocks on the network in the hot
 * path. An invalid, malformed, or expired token throws and the upgrade is
 * refused.
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
  userId: string;
}

export class AuthError extends Error {}

export interface SocketAuthenticator {
  /** Resolve the user for a token, or throw AuthError if it is not valid. */
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
      authenticate: (token) => verify(token, jwks, verifyOpts),
    };
  }

  if (cfg.devSecret) {
    const key = new TextEncoder().encode(cfg.devSecret);
    return {
      authenticate: (token) => verify(token, key, verifyOpts),
    };
  }

  throw new Error(
    "no auth configured: set CONVEX_JWKS_URL (prod), GATEWAY_DEV_JWT_SECRET (dev), " +
      "or GATEWAY_AUTH_DISABLED=1 (local smoke only)",
  );
}

async function verify(
  token: string | undefined,
  key: JWTVerifyGetKey | Uint8Array,
  opts: { issuer?: string; audience?: string },
): Promise<AuthedUser> {
  if (!token) throw new AuthError("missing token");
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
