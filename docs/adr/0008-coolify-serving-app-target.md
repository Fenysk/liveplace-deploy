# ADR-0008 — The Coolify deploy target is `ydt5…` (the app that owns `liveplace.tv`), not the sslip.io duplicate

- Status: **Accepted**
- Date: 2026-07-14
- Owner / decider: DevOps (owns reproducible deploy + Coolify runtime chain)
- Issue: FEN-1781 (deploy of FEN-1780 kept "finishing" without ever changing the
  served surface). Sibling symptom on FEN-1822 (Dev Frontend redeployed repeatedly,
  build marker never appeared).
- Affects: `infra/coolify/deploy.env` (`COOLIFY_APP_UUID`, `PUBLIC_BASE_URL`),
  every `GET /api/v1/deploy?uuid=…` force-deploy call, the C1/C8 release rules.
- Complements ADR-0005 / ADR-0007 (deploy-source guards). This ADR fixes the deploy
  **destination**.

## Context — two Coolify apps named "liveplace", one dead end

The Coolify instance (`coolify.fenysk.fr`, resolvable only inside the VPS network →
pin `--resolve coolify.fenysk.fr:443:173.212.248.163`) hosts **two** applications
literally named `liveplace`, both wired to the same mirror `Fenysk/liveplace-deploy.git`
`main`, both `build_pack: dockercompose`:

| uuid | `docker_compose_domains` | fqdn | serves liveplace.tv? |
|------|--------------------------|------|----------------------|
| `i1096taktl1ejr2w1zlij7no` | `null` | `…i1096….sslip.io` | **NO** |
| `ydt5ysqbmk9tglqwv88lgdy0` | `{"proxy":{"domain":"https://liveplace.tv"}}` | — | **YES** |

`infra/coolify/deploy.env` had drifted to `COOLIFY_APP_UUID=i1096…` (and
`PUBLIC_BASE_URL=http://i1096….sslip.io`). Every force-deploy therefore rebuilt and
restarted the **`i1096` duplicate**, which owns no domain, while `liveplace.tv`
(routed by Coolify's Traefik to `ydt5`'s `proxy` service) was **never redeployed**.

This is a textbook **C8 "trompeur" failure**: the deploy API returned
`status: finished`, `force_rebuild: true`, on the correct mirror commit — every
signal green — yet the served bundle on `liveplace.tv` never moved. Hours were spent
chasing a phantom Docker build-cache bug (adding a `CACHE_BUST` ARG, wiring it through
compose, bumping the env, even `docker compose build --no-cache`), all on the wrong
app, because the served-surface hash never changed. `--no-cache` proving the bundle
*still* stale is what finally excluded "build cache" and pointed at "wrong destination".

## Decision

1. **The one and only prod deploy target is `ydt5ysqbmk9tglqwv88lgdy0`** — the app
   whose `docker_compose_domains` maps `proxy → https://liveplace.tv`. `deploy.env` is
   corrected to it (`COOLIFY_APP_UUID=ydt5…`, `PUBLIC_BASE_URL=https://liveplace.tv`).
2. **A deploy is not "done" until the served surface on `liveplace.tv` changes.**
   Coolify `status: finished` alone is worthless here (it was green on the dead app).
   Proof = an anti-stale marker on `liveplace.tv` (asset-hash roll and/or a committed
   `<!-- build:… -->` marker in `apps/web/index.html`), per C2/C8.
3. **Target selection is topology** (C1): never deploy an app whose
   `docker_compose_domains` does not contain `liveplace.tv`. Before trusting any
   `deploy.env` in a fresh checkout, confirm the target via
   `GET /api/v1/applications/<uuid>` → `docker_compose_domains`.
4. `i1096…` is a non-serving duplicate. It is left running but **must not be a deploy
   target**. Decommissioning it (or renaming so it can't be confused) is follow-up
   (see FEN child issue) — not done here to avoid touching prod topology under time pressure.

## Consequences

- `deploy.env` is gitignored and **per-checkout** → the same drift can recur in another
  agent's workspace. Mitigation: this ADR + a follow-up deploy-guard that refuses a
  target lacking the `liveplace.tv` domain and requires a post-deploy served-marker check.
- The `CACHE_BUST` ARG (Dockerfile) + compose wiring added during the investigation are
  harmless and kept; they are belt-and-suspenders, **not** the root cause. Content-hash
  layer invalidation was never actually broken.
