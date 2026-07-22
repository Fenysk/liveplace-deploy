# Runbook — LivePlace prod deploy (Coolify VPS)

Ship LivePlace to the public **Coolify** VPS. The real prod path is a **guarded
mirror force-push** (`scripts/mirror-push.mjs`) → **Coolify force-deploy API** →
**poll** → **verify the served surface**. Env is managed directly in the Coolify
app (UI/API), **never pushed by a deploy script** — the old scripted Coolify
env-push path clobbed the prod env repeatedly and was **removed** (FEN-2041, audit
[FEN-2034](/FEN/issues/FEN-2034#document-audit) décision D1).

> TL;DR update loop — code-only change:
> `node scripts/mirror-push.mjs` → the push to `liveplace-deploy@main`
> auto-triggers a Coolify rebuild (or fire `GET /api/v1/deploy?uuid=<APP>&force=true`)
> → poll deployment status → **verify the served surface**, not the local hash (C2/C8).

## The deploy is a mirror force-push, not a script that pushes env

Coolify builds our stack by **cloning a git repo** and running the `dockercompose`
build pack (the compose BUILDS the gateway / web / worker / convex-deploy images
from in-repo Dockerfiles — a raw image-only compose upload has no build context and
cannot build them). The canonical Paperclip remote is internal/unreachable, so the
tree is published to a **public mirror** Coolify can clone:
`Fenysk/liveplace-deploy.git@main`.

Prod is shipped by **force-pushing a secret-free, single-commit snapshot** of the
served release train (`origin/main`, C1) to that mirror. A push to the mirror's
`main` auto-triggers a Coolify rebuild on its own (webhook).

## Ship — `scripts/mirror-push.mjs` (the ONE guarded path, FEN-1763)

`mirror-push.mjs` IS the reproducible manual sequence (`git archive origin/main` →
strip `.github/workflows` → mono-commit → `git push --force`) with **two read-only
guards bolted in front of the push**:

- `assertDesignFingerprint` on the bundled `apps/web` `tokens.css` — refuses a
  neutral-S0 **design-clobber** bundle (`--elev-1: none`, the FEN-1580/1625/1629
  regression) so it can never reach prod through the raw git path.
- `assertSafeDeployPush` on the resolved remote/refspec — refuses any target that
  resolves to the canonical `liveplace.git` trunk (FEN-180).

Both guards run **before** the only network write; if either throws, nothing is pushed.

```bash
node scripts/mirror-push.mjs --dry-run                     # build → guard → STOP (verify offline, no push)
node scripts/mirror-push.mjs --dry-run --simulate-clobber  # tamper tokens.css → guard MUST abort (no push)
GITHUB_TOKEN=… node scripts/mirror-push.mjs                # build → guard → force-push mirror main
```

Defaults to snapshotting `origin/main`; override with `MIRROR_SOURCE_REF`. The token
is never printed and never lands in argv or the remote URL (one-shot `GIT_ASKPASS`
helper). ZERO npm deps: Node ≥ 22 + git + tar.

> **Workflow-scope note (FEN-1405).** The bundle includes `.github/workflows/ci.yml`,
> but Coolify never runs GitHub Actions — it only builds the dockercompose stack. A
> GitHub PAT without the `workflow` scope is *rejected* on a push that would touch
> `.github/workflows/*`. `mirror-push.mjs` strips `.github/workflows/` from the
> snapshot automatically; a manual path must `rm -rf .github/workflows` before commit.

**Manual fallback** (no PAT via the script / different host), same secret-free bytes
`mirror-push.mjs` wraps — run the fingerprint guard by hand before pushing:

```bash
node scripts/make-deploy-bundle.mjs      # → dist/liveplace-deploy.tar.gz  (git archive HEAD, no secrets/history)
mkdir /tmp/lp && tar -xzf dist/liveplace-deploy.tar.gz -C /tmp/lp
cd /tmp/lp && rm -rf .github/workflows
grep -q -- '--elev-1: none' apps/web/src/ui/styles/tokens.css && \
  { echo "🛑 design clobber (--elev-1: none) — refusing"; exit 1; }   # FEN-1763 guard
git init -b main && git add -A && git commit -m "LivePlace deploy bundle"
git remote add origin <mirror-repo-url> && git push --force origin main
```

## Trigger + poll + verify (Coolify force-deploy API)

A mirror-`main` push auto-deploys, but the reliable, readable path is an explicit
force-deploy call, then a **poll to a terminal state**, then a **served-surface
check** — never trust "finished" alone (C8: a green Coolify on a dead app is a trap,
[[liveplace-two-coolify-apps-deploy-target]]).

```bash
# force-deploy (uuid = ydt5 app, the one serving liveplace.tv — ADR-0008)
GET  $COOLIFY_URL/api/v1/deploy?uuid=<APP_UUID>&force=true         # Bearer $COOLIFY_API_TOKEN
# poll until the deployment record reaches finished/failed (not just queued/in_progress)
GET  $COOLIFY_URL/api/v1/deployments/<deployment_uuid>
# verify the SERVED surface — anti-stale marker on liveplace.tv, NOT a local build hash
node scripts/smoke.mjs                                            # web 200, WS upgrade, (auth on) OAuth round-trip
```

- **DNS pin caveat.** If the `443` vhost 503s persistently on `/api/v1`, hit the
  Coolify host directly (`http://173.212.248.163:8000/api/v1`, same Bearer) — the
  vhost-443 pin can 503 for ~1 min during upstream re-resolution after a force-deploy
  (transient, retry — not a regression).
- **`force` is kept ON** — a forced rebuild can never serve a cached/stale bundle
  (anti-stale guarantee) at **no extra downtime cost** (measured, see §Downtime).

## Env — managed in Coolify, never by a deploy script

The env lives in the **Coolify app** (UI or `PATCH /api/v1/applications/{uuid}/envs/bulk`),
persisted across redeploys. `infra/coolify/deploy.env.example` documents every key.
The old script that *derived and pushed* env on every deploy is gone (D1) — it was the
mechanism that overwrote hand-set prod values. Change env **deliberately** in Coolify;
the code-ship path (`mirror-push`) touches **only** the git tree.

Persist the generated `CONVEX_INSTANCE_SECRET` / `BETTER_AUTH_SECRET` /
`GATEWAY_INTERNAL_SECRET` in Coolify so redeploys stay stable.

### Provisioning inputs (from Alexis via the CEO)

Values an agent cannot self-supply, set once in the Coolify app env:

| Input | Where it comes from |
|---|---|
| `COOLIFY_URL` + `COOLIFY_API_TOKEN` (deploy+write+read) | Alexis (Paperclip project vars), relayed by the CEO |
| `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID`, `COOLIFY_APP_UUID` | Read once from the Coolify UI/API |
| `COOLIFY_GIT_REPOSITORY` (+ `…_BRANCH`) | The public mirror seeded by `scripts/coolify-wire-source.mjs` (one-time) |
| `PUBLIC_BASE_URL` | The FQDN routed to the stack (`https://liveplace.tv`) |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | **Leave blank** — minted in-stack at `up` time (FEN-92, below). Set only to pin an externally-minted key. |
| `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` | Alexis, for real OAuth (auth-ON prod) |

> **One-time source wiring.** `scripts/coolify-wire-source.mjs` (given a `GITHUB_TOKEN`)
> creates the public mirror, pushes the first secret-free bundle, and writes
> `COOLIFY_GIT_REPOSITORY` into `deploy.env`. After that, all ships go through
> `mirror-push.mjs`; wire-source is not part of the update loop.

### The Convex admin key — minted in-stack, no manual step (FEN-92)

The hot pixel path is Redis-only, but the gateway/worker are gated on the
`convex-deploy` one-shot completing, and `convex deploy` authenticates with
`CONVEX_SELF_HOSTED_ADMIN_KEY`. That key is **deterministic per
`CONVEX_INSTANCE_SECRET`**. `docker-compose.yml` ships a `convex-admin-key` one-shot
that runs `generate_admin_key.sh` (baked into the `convex-backend` image) from a
throwaway container sharing `INSTANCE_NAME` + `INSTANCE_SECRET` with the backend, and
writes the key to the shared `convex-admin` volume. `convex-deploy` reads it from
`/admin/admin_key` (`apps/convex/deploy.sh`) and pushes the functions → persistence is
enabled on a plain `up`, **zero manual intervention**.

- **Leave `CONVEX_SELF_HOSTED_ADMIN_KEY` blank**; an operator-supplied value still wins.
- The mint is **idempotent** (same secret → same key) and **best-effort**: on failure
  the one-shot exits 0 and the stack comes up anonymous (no persistence) instead of
  hard-failing `up` — observable in the `convex-admin-key` logs, not a dead stack.
- Keep `CONVEX_INSTANCE_SECRET` stable across redeploys so the minted key stays valid.

## TLS / D5 — HTTPS Twitch callback

Coolify's own proxy terminates TLS at the edge and routes the public FQDN to the
stack, so the internal Caddy stays HTTP (`SITE_ADDRESS=:80`) and our compose does
**not** republish host 80/443 (`PROXY_HTTP_PORT/HTTPS_PORT` default to 8080/8443 to
avoid colliding with Coolify's proxy). The public HTTPS callback
`${PUBLIC_BASE_URL}/api/auth/callback/twitch` is reachable through the Coolify edge →
internal Caddy `/api/auth*` → Convex site origin. **Verify against the live instance:**
that the public FQDN is bound to the `proxy` service — the one item only confirmable
with the running Coolify.

## Going from anonymous → real Twitch OAuth

Set `GATEWAY_AUTH_DISABLED=0` (or drop it — the runtime default is auth-ON,
`apps/gateway/src/config.ts:141`), fill `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET` in
the Coolify app env, set the Twitch console redirect URL to
`${PUBLIC_BASE_URL}/api/auth/callback/twitch`, then re-ship (`mirror-push` + force-deploy).
The full public-launch flip is in `public-launch-hardening.md`; the authenticated smoke
path (`TICKET=…`) is in `nas-deploy.md` §5.

## Deploy downtime — measured root cause (FEN-1101)

**1. A push to `liveplace-deploy@main` auto-triggers a Coolify rebuild.** Coolify
watches the mirror; *any* push to `main` (including a fresh snapshot) fires a webhook
deploy on its own. So for a **code-only** change, `mirror-push.mjs` alone ships it —
the explicit force-deploy call is for readability/anti-stale, not strictly required.
Env changes are separate (they are set in Coolify, not pushed).

**2. Every Coolify deploy of this app 503s for ~the whole build window, `force`-INDEPENDENT.**
Measured on FEN-1101: a redeploy of an *unchanged* commit with `force_rebuild=false`
still returned `503 "no available server"` for **~112 s** (`15:50:52 → 15:52:44Z`),
clearing only after `build: finished`. Dropping `force` does **not** buy zero-downtime:
Coolify's `dockercompose` build pack has **no rolling / zero-downtime strategy** — the
stack (and its edge route) is unavailable while the deploy runs.

**Options for true zero-downtime** (D4 reverse-proxy / deploy-pipeline call, none free):

- **Registry-based deploy (recommended).** Build web/gateway in CI, push to a registry,
  have Coolify *pull + recreate* instead of *build-on-host* → collapses the window to a
  few-second container swap. Cost: CI build + registry + compose `image:` refs.
- **Stable external edge.** A reverse proxy *outside* the Coolify compose project (so it
  survives stack recreation) that holds/retries connections while the backend cycles.
  Cost: changes D4 topology.
- **Accept it.** Self-heals in <2 min, benign for hobby-scale — batch changes, avoid peak.

The `proxy` (Caddy) service carries a `healthcheck` (`/healthz` through Caddy to web) so
the orchestrator only reports the rollout done once the full public path serves — but it
does **not** by itself remove the build-window 503.

## Rollback

- **Bad deploy:** Coolify keeps the previous build. Roll back from the UI, or re-ship a
  known-good commit: `MIRROR_SOURCE_REF=<good-sha> node scripts/mirror-push.mjs` (the
  push auto-triggers the deploy), then poll + verify the served surface.
- **Bad env:** re-set the previous values in the Coolify app env (UI or
  `PATCH …/envs/bulk`) and redeploy. Env is not versioned by the code ship — keep known
  values to hand.
- **Full teardown:** stop/delete the application via the Coolify API/UI; volumes
  (redis-data, convex-data, caddy-*) persist unless explicitly removed.
- Blast radius is one Coolify application; the NAS path (`nas-deploy.md`) is independent
  and uses the same compose unchanged.
