# Runbook — NAS deploy + runtime verification (FEN-25)

End-to-end procedure to bring the LivePlace stack up on the NAS and verify the
two Phase-1 exit gates: **(1)** `docker compose up` healthy, **(2)** Twitch OAuth
login → live pixel. Everything here is scripted/turnkey; the only inputs a human
must supply are a Twitch app and a Docker host (see "Prerequisites").

> Static pre-flight done by the Founding Engineer (no Docker needed): code is
> green (`pnpm -r build && pnpm -r typecheck && pnpm --filter @liveplace/protocol
> test`), `docker-compose.yml` parses and its healthchecks are image-correct, and
> the WS live-pixel smoke (`scripts/smoke.mjs`) was validated against a faithful
> protocol emulation. What remains genuinely needs a Docker host + Twitch creds.

## Prerequisites (human-provided — rule #1)

1. **Docker host** — the NAS (or any box) with Docker Engine + Compose v2.
   `arm64` and `amd64` are both supported (multi-arch base images + builds).
2. **Twitch application** — register at <https://dev.twitch.tv/console/apps>:
   - Note the **Client ID** and generate a **Client Secret**.
   - **OAuth Redirect URL** must be exactly `${BETTER_AUTH_URL}/api/auth/callback/twitch`
     e.g. `https://liveplace.example.com/api/auth/callback/twitch`.
3. **A hostname** Caddy can serve. Public DNS name → automatic Let's Encrypt TLS.
   LAN-only NAS → use a `*.localhost` / internal name and uncomment `tls internal`
   in `infra/Caddyfile`.

## 1. Configure `.env`

```bash
cp .env.example .env
# Generate the three secrets:
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
echo "CONVEX_INSTANCE_SECRET=$(openssl rand -hex 32)"
```

Edit `.env` and set: `LIVEPLACE_HOST`, the three `PUBLIC_*` URLs, `BETTER_AUTH_URL`
(= your public web URL), `BETTER_AUTH_SECRET`, `CONVEX_INSTANCE_SECRET`,
`TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET`. Leave `CONVEX_SELF_HOSTED_ADMIN_KEY`
as a placeholder for now — it is generated in step 3.

> Secrets live only in `.env` (gitignored) or Docker secrets on the NAS. Never commit them.

## 2. Bring the stack up

```bash
docker compose up -d --build      # builds gateway+web images, pulls redis/convex/caddy
watch docker compose ps           # wait until redis, convex-backend, gateway, web are "healthy"
```

Expected: `redis`, `convex-backend`, `gateway`, `web` report **healthy**; `proxy`
reports **running** (it has no healthcheck). If a service is stuck `starting` or
`unhealthy`, see Troubleshooting.

**Gate 1 evidence to attach:** output of `docker compose ps` (all healthy) and, if
anything misbehaved, `docker compose logs <service>`.

## 3. Deploy Convex functions (one-time)

The self-hosted Convex backend mints its own admin key after it starts:

```bash
# generate an admin key inside the running backend
docker compose exec convex-backend ./generate_admin_key.sh
# put the printed key into .env as CONVEX_SELF_HOSTED_ADMIN_KEY, then:
pnpm --filter @liveplace/convex run deploy   # NOTE: `run` — `pnpm deploy` is a builtin
```

This pushes `apps/convex/convex/{schema,canvas}.ts` to the backend. (The live pixel
path in step 5 works without this — Convex is the durable mirror, not the hot path —
but deploy it so audit/snapshots persist.)

## 4. (Gate 2a) Twitch OAuth login — manual, browser

1. Open `https://<LIVEPLACE_HOST>/` → click **Login with Twitch**.
2. Authorize on Twitch → you are redirected back, logged in (HUD shows your user).
   - If the callback errors, the Redirect URL in the Twitch console must match
     `${BETTER_AUTH_URL}/api/auth/callback/twitch` character-for-character.
3. Place a pixel on the canvas → it appears immediately for you.
4. Open `https://<LIVEPLACE_HOST>/obs` in a second tab → the pixel is visible there
   too (OBS view, no HUD). Place another pixel in tab 1 → it appears live in `/obs`.

**Gate 2 evidence to attach:** a screenshot of the logged-in canvas and the `/obs`
view showing the same pixel.

## 5. (Gate 2b) Automated WS live-pixel smoke

This script drives the full wire path: `web /healthz → gateway /healthz → hello →
welcome + binary snapshot → place → ack → live broadcast on a second connection`.
Zero dependencies (Node ≥ 22 global `fetch`/`WebSocket`).

**Authenticated (recommended — exercises the real ticket path):**
```bash
# Get a ticket from an authenticated browser session (DevTools console on the site):
#   await fetch('/api/ws-ticket',{method:'POST'}).then(r=>r.json())
TICKET=<ticket> \
WEB_URL=https://<LIVEPLACE_HOST> \
GATEWAY_HTTP_URL= \
GATEWAY_WS_URL=wss://<LIVEPLACE_HOST>/ws \
node scripts/smoke.mjs
```

**Anonymous (no Twitch needed — quick stack check):** bring the stack up with
`GATEWAY_REQUIRE_AUTH=false` in `.env`, then from the NAS host:
```bash
node scripts/smoke.mjs        # defaults to localhost:3000 / localhost:8080
```

Expect `✅ SMOKE PASSED`. Attach the script output to the ticket.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `web` stuck `unhealthy` | Health probe is `node -e fetch(...)`; check `docker compose logs web` for a startup throw (missing `BETTER_AUTH_*`/`TWITCH_*` env — `auth.ts` requires them). |
| `convex-backend` never `healthy` → `web` won't start | Probe is `curl -f /version`. Check `docker compose logs convex-backend`; ensure `CONVEX_INSTANCE_SECRET` is set. |
| Twitch callback `redirect_mismatch` | Twitch console Redirect URL ≠ `${BETTER_AUTH_URL}/api/auth/callback/twitch`. |
| Browser can't reach `wss://.../ws` | Caddy routes `/ws*` → gateway:8080 (see `infra/Caddyfile`); confirm `PUBLIC_WS_URL` uses `wss://` and the `/ws` path. |
| smoke: `unauthenticated` | Gateway requires a ticket; pass `TICKET=` or set `GATEWAY_REQUIRE_AUTH=false`. |
| TLS fails on a LAN-only NAS | Uncomment `tls internal` in `infra/Caddyfile` and use a non-public hostname. |

## What to paste back into FEN-25

- `docker compose ps` showing all services healthy (Gate 1).
- Screenshot: logged-in canvas + `/obs` showing the same live pixel (Gate 2a).
- `node scripts/smoke.mjs` output ending in `✅ SMOKE PASSED` (Gate 2b).
