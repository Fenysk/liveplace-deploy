# Contract — Auth & session flow (FROZEN, v2 — reconciled with F1/FEN-11 + gateway/FEN-13)

> **v2 reconciliation (FEN-48, 2026-06-02, Founding Engineer).** The original v1
> of this contract described an `apps/web` Node/Hono server hosting Better Auth
> behind a **session cookie**, plus a one-time **Redis WS ticket** minted by
> `POST /api/ws-ticket` and consumed by the gateway via `GETDEL`. **None of that
> shipped.** F1 ([FEN-11](/FEN/issues/FEN-11)) delivered Better Auth as the
> **`@convex-dev/better-auth` Convex component** with a **JWT** session and **no
> app-tier server**, and the gateway ([FEN-13](/FEN/issues/FEN-13)) authenticates
> sockets by **verifying that Convex JWT offline against JWKS** — there is no WS
> ticket. This document is rewritten to match what is built and is the
> authoritative frozen contract. Rationale of the bridge decision lives in
> [ADR-0002](../adr/0002-auth-gateway-jwt-bridge.md).

Better Auth + Twitch OAuth for login; the **Convex session JWT** bridges the
authenticated browser to the (separate) WS gateway.

## Components

- **Auth surface** — Better Auth runs inside the **`@convex-dev/better-auth`
  Convex component**, served by Convex at `${CONVEX_SITE_URL}/api/auth/*`
  (routes registered in `apps/convex/convex/http.ts`, CORS restricted to
  `SITE_URL`). Provider: Twitch OAuth. There is **no `apps/web` Node/Hono
  server** — `apps/web` is a pure Vite SPA that talks **directly** to Convex.
- **Session** — a **JWT** issued by the Better Auth component and made available
  to the browser by the `convexClient()` plugin so Convex queries/mutations run
  authenticated. (No session cookie; no app-tier session store.)
- **Gateway** — does **not** run Better Auth and holds no session state. It
  verifies the Convex JWT a client presents at connect time, **offline against
  Convex's JWKS** (cached/refreshed by `jose`), and reads `userId` from the
  `sub` claim. Keeps the internet-facing socket fleet decoupled from auth
  internals — same goal as the retired ticket, achieved with one cached key set
  and zero per-connect network/Redis ops.

## Login flow (browser → Convex)

```
Browser → GET  ${CONVEX_SITE_URL}/api/auth/sign-in/twitch   (Better Auth on Convex)
        → 302  Twitch authorize
Twitch  → 302  ${CONVEX_SITE_URL}/api/auth/callback/twitch?code=…
        →      Better Auth verifies, creates user+account+session, mints JWT
        → redirect to app; SPA now holds the Convex JWT (convexClient plugin)
```

Register the Twitch app redirect URL as
`${CONVEX_SITE_URL}/api/auth/callback/twitch`. `TWITCH_CLIENT_ID` /
`TWITCH_CLIENT_SECRET` / `BETTER_AUTH_SECRET` come from Convex env / Docker
secrets — never committed. Scopes: `user:read:email`, `moderation:read`
(see `apps/convex/convex/auth.ts`).

## WS handshake (browser → gateway)

```
Browser (authenticated): obtain the Convex session JWT from the auth client.
   → open wss://host/ws  with the JWT presented as either:
        • Authorization: Bearer <jwt>     (PREFERRED)
        • ?token=<jwt>                    (fallback; avoid — lands in proxy/access logs)
Gateway → jwtVerify(jwt) against Convex JWKS, offline   → userId = sub  (or 401)
        → welcome { protocolVersion, width, height, seq, … }

Browser (anonymous): no JWT presented.
   → gateway grants read-only (view canvas; no `place`).      [see "Known gap" below]
```

- **Stateless verify:** keys are fetched once from JWKS and cached; an invalid,
  malformed, or expired token throws and the upgrade is refused with `401`.
- **Subject:** `userId` is the JWT `sub`; the gateway never reads Better Auth
  tables. `place` without a user ⇒ `error { code: "unauthenticated" }` (CA5).
- **No ticket, no Redis on the auth path:** the `POST /api/ws-ticket` endpoint,
  the `wsticket:{ticket}` Redis key, and the `GETDEL` consume step from v1 are
  **retired**. Nothing mints a ticket; nothing needs to.

### Gateway auth env (Convex JWT verification)

| env var                 | value                                              |
| ----------------------- | -------------------------------------------------- |
| `CONVEX_JWKS_URL`       | `${CONVEX_SITE_URL}/api/auth/convex/jwks` (prod; internal `http://convex-backend:3211/api/auth/convex/jwks`) — FEN-211: NOT `.well-known`, which serves SPA HTML |
| `GATEWAY_JWT_ISSUER`    | `${PUBLIC_SITE_URL}` (the `iss` claim = better-auth baseURL, e.g. `https://liveplace.tv`; empty ⇒ skip check) — FEN-211 |
| `GATEWAY_JWT_AUDIENCE`  | `convex` (the `applicationID` / `aud` claim)       |
| `GATEWAY_DEV_JWT_SECRET`| HS256 shared secret — **local dev only**           |
| `GATEWAY_AUTH_DISABLED` | `1` accepts every socket as anon — **smoke only**  |

## Why the Convex JWT (not a ticket) on the WS

The v1 ticket existed to keep the stateless gateway off the auth DB on the hot
connect path (one Redis op instead of a session lookup). Direct JWT verification
meets the **same** goal **better**: JWKS keys are cached in-process, so a connect
costs **zero** network/Redis ops, and there is **no producer to build or run**
(no Convex→Redis coupling, no second endpoint). The trade-off vs. a 60 s
single-use ticket: the JWT is multi-use until it expires, so if it leaks it is a
bearer credential for that window. Mitigations: keep the Convex JWT TTL short
(Convex default is minutes, auto-refreshed by the client); **prefer the
`Authorization: Bearer` header over `?token=`** so it never lands in proxy
access logs; terminate TLS at the reverse proxy. See ADR-0002 for the full
rationale and the rejected "Convex httpAction mints a Redis ticket" alternative.

## Sessions & identity

- The Better Auth Convex component owns the `user` / `account` / `session` /
  JWKS tables; Twitch access/refresh tokens are stored there server-side and are
  **never** returned to the browser (CA3). On first sign-in a trigger creates the
  app-side `profiles` row (CA1) — see `apps/convex/convex/auth.ts`. MVP profile
  fields: Twitch id, login, display name, avatar (see ADR-0001 / schema).
- Server-only `getTwitchAccessToken` (internal action) returns a fresh,
  auto-refreshed Twitch token for server features (e.g. F8 mod sync, CA4); the
  browser cannot call it.
- The gateway only ever needs the `userId` string (JWT `sub`).

## Known gap (tracked, not part of this contract's decision)

The shipped gateway **rejects tokenless upgrades** in real-auth mode (a missing
token throws `AuthError` → `401`); only the smoke-only `GATEWAY_AUTH_DISABLED`
path admits anonymous sockets. The "anonymous ⇒ read-only viewer" behavior this
contract specifies (required for the public canvas + OBS browser-source view) is
therefore **not yet implemented**. Fix is gateway-side: when **no** token is
presented, admit the socket as anonymous (`userId = null`, read-only, no
`place`); keep rejecting upgrades that present a token which fails verification.
Tracked as a follow-up child issue against FEN-13.

## Implementation pointers

- `apps/convex/convex/auth.ts` — Better Auth component config (`twitch`
  provider), `me` query, `getTwitchAccessToken`.
- `apps/convex/convex/http.ts` — auth routes at `${CONVEX_SITE_URL}/api/auth/*`.
- `apps/web/src/auth/auth-client.ts` — SPA Better Auth client (talks directly to
  Convex; `convexClient()` exposes the JWT).
- `apps/gateway/src/auth.ts` — `createAuthenticator` (JWKS / dev-secret /
  disabled) + JWT verify; `apps/gateway/src/gateway.ts` `extractToken` +
  `authenticateUpgrade`.
- Verification (needs real Twitch app credentials + running stack) is tracked in
  [FEN-11](/FEN/issues/FEN-11).
