# Public-launch hardening — login + HTTPS (FEN-88)

**Status: STAGED, gated on Alexis's decision.** This runbook is the exact, reversible
flip DevOps applies the moment Alexis decides "durcir pour le public". It is NOT applied
yet — the current Coolify deploy (FEN-80) is an intentionally open **anonymous test**
(every socket accepted, plain HTTP) and flipping now would break it (Twitch login is not
wired yet). See the decision interaction on FEN-88.

## Why it is gated (not auto-fixed)

The FEN-85 audit flagged two configs as deliberately "open" for the anon test:

| # | Sev | What | Where |
|---|-----|------|-------|
| 1 | ÉLEVÉ | Login disabled by default (`GATEWAY_AUTH_DISABLED=1`) → anyone draws with no Twitch identity (no attribution, no nominal moderation, no per-user rate-limit) | `scripts/coolify-deploy.mjs:169`, `infra/coolify/deploy.env.example:76` |
| 2 | MOYEN | No public HTTPS (`SITE_ADDRESS=:80`, sslip.io HTTP) → session cookies + Convex tokens travel in clear once login is on | `scripts/coolify-deploy.mjs:163`, `infra/Caddyfile` |

Hardening requires three inputs only Alexis/board can supply, hence the gate:
- the **decision** (harden now vs keep test open until Twitch login ready),
- **Twitch app creds** (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`) for the real OAuth provider,
- a **real FQDN** with Let's Encrypt (sslip.io serves HTTP only here).

## The flip (exact diff) — apply ONLY after the decision

### 1. Login on by default (opt-out only for explicit smokes)

`scripts/coolify-deploy.mjs` (~L169):
```diff
-    GATEWAY_AUTH_DISABLED: e.GATEWAY_AUTH_DISABLED ?? "1",
+    GATEWAY_AUTH_DISABLED: e.GATEWAY_AUTH_DISABLED ?? "0",
```
`infra/coolify/deploy.env.example` (~L76):
```diff
-GATEWAY_AUTH_DISABLED=1
+GATEWAY_AUTH_DISABLED=0
```
Net effect: the stack boots auth-ON; anon smokes must now opt **in** with an explicit
`GATEWAY_AUTH_DISABLED=1` in `deploy.env`. Requires `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`
present in the deploy env (script already passes them through; `apps/web/server/auth.ts`
`required()` throws if missing — so the missing-creds case fails loud, not silently open).

### 2. HTTPS on the real domain

The D5 model is unchanged: **TLS terminates at the Coolify edge; the internal stack stays
HTTP** (`SITE_ADDRESS=:80`, Caddy never republishes 80/443). Hardening = make the public
origin `https://` and force-redirect:

1. In Coolify, bind the **real FQDN** (e.g. `liveplace.tv`) to the `proxy` service and enable
   **Let's Encrypt** + **"Force HTTPS / Redirect to HTTPS"** on that app.
2. Set the public base to https in `deploy.env`:
   ```diff
   -PUBLIC_BASE_URL=
   +PUBLIC_BASE_URL=https://liveplace.tv
   ```
   The script derives the rest automatically from a `https://` base:
   `PUBLIC_WS_URL=wss://<host>/ws`, `BETTER_AUTH_URL`, `VITE_CONVEX_*`, and the smoke flips to
   `wss://` (`coolify-deploy.mjs:162,445`). No Caddyfile change needed for the edge-TLS model.
3. Update the **Twitch app** OAuth redirect URI to `https://liveplace.tv/api/auth/callback/twitch`.

> Alternative (Caddy-terminated TLS, if Coolify edge is not used for TLS): set
> `SITE_ADDRESS=liveplace.tv` (bare host) → Caddy auto-provisions Let's Encrypt on 443, and
> republish `PROXY_HTTPS_PORT`. Edge-termination (above) is preferred on Coolify to avoid
> double-proxy / port collisions (see `docs/runbooks/coolify-deploy.md`).

### 3. Redeploy + verify
```sh
cd <_default>
node scripts/coolify-deploy.mjs            # pushes env, redeploys, waits healthy, runs smoke over wss://
# smoke asserts: web 200, WS upgrade, and (auth on) the Twitch OAuth round-trip
```
Acceptance: `https://liveplace.tv` serves over valid TLS, `http://` → 301 https, an
unauthenticated socket is **rejected**, the Twitch login + callback completes, draw works.

## Rollback

Revert this commit's two `?? "0"` / `=0` lines back to `1`, set `PUBLIC_BASE_URL` back to the
sslip.io HTTP URL, disable Force-HTTPS in Coolify, redeploy. The anon test stack returns.
Because login default is the only behavioural switch, rollback is a one-line + one-redeploy op.
