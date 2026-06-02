# ADR-0002 — Bridge auth → WS gateway with the Convex session JWT (retire the WS ticket)

- Status: **Accepted**
- Date: 2026-06-02
- Owner / decider: Founding Engineer
- Affects: FEN-48 (this decision), FEN-11 (F1 auth, shipped), FEN-13 (gateway,
  shipped), `docs/contracts/auth-flow.md`

## Context

The frozen auth contract (v1) specified that the browser, holding a Better Auth
**session cookie** from an `apps/web` Node/Hono server, would `POST /api/ws-ticket`
to mint a one-time **Redis WS ticket** (`SET wsticket:{ticket}=userId PX ~60s`),
then present that ticket on the WS upgrade; the gateway would consume it via
`GETDEL`. The ticket existed so the stateless gateway could authenticate a socket
with **one Redis op** instead of a session-DB lookup on the hot connect path.

What actually shipped diverged on both ends:

- **F1 / FEN-11** delivered Better Auth as the **`@convex-dev/better-auth` Convex
  component**. There is **no `apps/web` app-tier server**; `apps/web` is a pure
  Vite SPA talking directly to Convex, and the session is a **JWT** (exposed to
  the browser by the `convexClient()` plugin), not a cookie. So there is no
  "auth surface" left to host `POST /api/ws-ticket`.
- **Gateway / FEN-13** never implemented the ticket. It extracts a **JWT** from
  the upgrade (`Authorization: Bearer` or `?token=`) and verifies it **offline
  against Convex JWKS** (`jose` `createRemoteJWKSet`), reading `userId` from
  `sub`. There is no `wsticket:` key, no `GETDEL`, no ticket producer anywhere in
  the codebase.

FEN-48 asks: in the SPA-direct model, *where is the WS ticket emitted?* The
honest answer is that the implemented system already chose a different, simpler
bridge and dropped the ticket. This ADR ratifies that choice rather than
rebuilding the ticket.

## Decision

**The browser presents its Convex session JWT directly on the WS upgrade; the
gateway verifies it offline against Convex JWKS. The WS ticket mechanism
(`POST /api/ws-ticket`, the `wsticket:{ticket}` Redis key, and `GETDEL`) is
retired.** No Convex action or endpoint mints a ticket.

Gateway env: `CONVEX_JWKS_URL = ${CONVEX_SITE_URL}/.well-known/jwks.json`,
`GATEWAY_JWT_ISSUER = ${CONVEX_SITE_URL}`, `GATEWAY_JWT_AUDIENCE = convex`.

## Alternatives considered

- **A — Convex `httpAction` mints a Redis ticket (resurrect v1).** An
  authenticated Convex HTTP action does `SET wsticket:{ticket}=userId PX <ttl>`;
  gateway keeps `GETDEL`. *Rejected:* it requires building a new endpoint AND
  reverting the already-shipped, tested JWT gateway, and it couples the Convex
  app-tier to Redis (network access + credentials on the auth path) purely to
  reproduce a guarantee JWKS verification already provides more cheaply.
- **B (chosen) — direct Convex JWT + JWKS verification.** Zero new endpoints,
  uses code already in `apps/gateway/src/auth.ts`, and the SPA already holds the
  JWT via `convexClient()`.

## Consequences

- **Pro:** the original design goal — a stateless gateway that authenticates a
  socket without an auth-DB call — is met *better*: JWKS keys are cached
  in-process, so a connect costs **zero** network/Redis ops. No producer to build
  or operate; no Convex→Redis coupling.
- **Trade-off:** unlike a 60 s single-use ticket, the JWT is multi-use until it
  expires, so a leaked token is a bearer credential for that window. Mitigations
  (recorded in `auth-flow.md`): keep the Convex JWT TTL short (Convex default,
  auto-refreshed); **prefer `Authorization: Bearer` over `?token=`** so the token
  never lands in proxy/access logs; terminate TLS at the reverse proxy.
- **Follow-up (not this decision):** the shipped gateway rejects *tokenless*
  upgrades in real-auth mode, so anonymous read-only viewing (needed for the
  public canvas + OBS browser source) is not yet supported. Fix is gateway-side
  (admit a tokenless socket as anonymous read-only; keep rejecting *invalid*
  tokens). Tracked as a follow-up child issue against FEN-13.
