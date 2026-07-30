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
| 1 | ÉLEVÉ | Login disabled by default (`GATEWAY_AUTH_DISABLED=1`) → anyone draws with no Twitch identity (no attribution, no nominal moderation, no per-user rate-limit) | `apps/gateway/src/config.ts:141` (runtime default, now safe: auth ON), `infra/coolify/deploy.env.example` |
| 2 | MOYEN | No public HTTPS (`SITE_ADDRESS=:80`, sslip.io HTTP) → session cookies + Convex tokens travel in clear once login is on | `docker-compose.yml:292` (`SITE_ADDRESS`), `infra/Caddyfile` |

Hardening requires three inputs only Alexis/board can supply, hence the gate:
- the **decision** (harden now vs keep test open until Twitch login ready),
- **Twitch app creds** (`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`) for the real OAuth provider,
- a **real FQDN** with Let's Encrypt (sslip.io serves HTTP only here).

## The flip (exact diff) — apply ONLY after the decision

### 1. Login on by default (opt-out only for explicit smokes)

The runtime default is **already safe** — `apps/gateway/src/config.ts:141` reads
`bool("GATEWAY_AUTH_DISABLED", false)`, so an unset var boots **auth-ON**. The flip is
therefore purely an **env** decision, no code edit: make sure `GATEWAY_AUTH_DISABLED`
is **not** set to `1` in the Coolify app env / `deploy.env`.
```diff
-GATEWAY_AUTH_DISABLED=1
+GATEWAY_AUTH_DISABLED=0   # (or simply drop the line — default is 0)
```
Net effect: the stack boots auth-ON; anon smokes must opt **in** with an explicit
`GATEWAY_AUTH_DISABLED=1`. Requires `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`
present in the deploy env; `apps/web/server/auth.ts` `required()` throws if missing —
so the missing-creds case fails loud, not silently open.

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
   Derive the rest from the `https://` base and set them in the Coolify app env:
   `PUBLIC_WS_URL=wss://<host>/ws`, `BETTER_AUTH_URL`, `VITE_CONVEX_*`; `scripts/smoke.mjs`
   flips to `wss://` when `PUBLIC_BASE_URL` is `https://`. No Caddyfile change needed for the
   edge-TLS model.
3. Update the **Twitch app** OAuth redirect URI to `https://liveplace.tv/api/auth/callback/twitch`.

> Alternative (Caddy-terminated TLS, if Coolify edge is not used for TLS): set
> `SITE_ADDRESS=liveplace.tv` (bare host) → Caddy auto-provisions Let's Encrypt on 443, and
> republish `PROXY_HTTPS_PORT`. Edge-termination (above) is preferred on Coolify to avoid
> double-proxy / port collisions (see `docs/runbooks/coolify-deploy.md`).

### 3. Redeploy + verify
Set the env changes above directly in the Coolify app env (UI/API — the deploy path
does **not** push env, D1/FEN-2041), then ship + verify:
```sh
cd <_default>
node scripts/mirror-push.mjs               # build → guard → force-push mirror main (auto-triggers rebuild)
# then: GET $COOLIFY_URL/api/v1/deploy?uuid=<APP>&force=true  → poll deployment status
node scripts/smoke.mjs                      # asserts: web 200, WS upgrade, (auth on) Twitch OAuth round-trip
```
Acceptance: `https://liveplace.tv` serves over valid TLS, `http://` → 301 https, an
unauthenticated socket is **rejected**, the Twitch login + callback completes, draw works.

## Rollback

Set `GATEWAY_AUTH_DISABLED=1` back in the Coolify app env, set `PUBLIC_BASE_URL` back to the
sslip.io HTTP URL, disable Force-HTTPS in Coolify, redeploy. The anon test stack returns.
Because login is an env switch (no code change), rollback is a one-env + one-redeploy op.
