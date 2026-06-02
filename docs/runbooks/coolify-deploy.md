# Runbook — agent-only Coolify deploy (FEN-80, executes FEN-79)

Deploy LivePlace to Alexis's public **Coolify** VPS, driven entirely by an agent
through the Coolify API (`/api/v1`, Bearer token). Goal: **zero intervention from
Alexis beyond the initial provisioning inputs**. The local NAS smoke already
passes (`✅ SMOKE PASSED`) and the reproducibility fixes (FEN-78) are in `main`.

> TL;DR future update loop: `git push` to the source repo → re-run
> `node scripts/coolify-deploy.mjs` (with `COOLIFY_APP_UUID` set) → one
> `GET /api/v1/deploy` fires and the smoke re-runs. One command, no UI.

## Source wiring — decision (Phase A)

**Chosen: a public git repository, deployed with Coolify's `dockercompose`
build pack.** Why, and why not the alternative:

- `docker-compose.yml` **builds** the gateway / web / worker / convex-deploy
  images from in-repo Dockerfiles. Coolify can only build those if it clones the
  **full source tree**. A raw-compose upload (`POST /applications/dockercompose`)
  has no build context, so it cannot build our images — it is only for
  image-only composes. Ruled out.
- The canonical remote lives on an internal Paperclip path Coolify cannot reach,
  so the tree must be published to a git host Coolify can pull.
- A **public** repo needs no deploy key — the simplest durable option. (A
  private repo works too via `POST /applications/private-deploy-key`; same flow,
  plus a `private_key_uuid`.)
- Durable update loop: `git push` + one deploy API call (or Coolify auto-deploy
  on push). This is the cheapest possible "future updates = one API call".

Produce the exact bytes Coolify will clone with:

```bash
node scripts/make-deploy-bundle.mjs      # → dist/liveplace-deploy.tar.gz
```

That tarball is `git archive HEAD` — git-tracked files only, no `node_modules`,
no `.env`, no secrets, no history.

**Agent-only path (recommended).** With a `GITHUB_TOKEN` (PAT, `repo` /
`contents:write`) in the env, one command does the whole one-time provisioning —
create the public repo, build the bundle, push it, and write
`COOLIFY_GIT_REPOSITORY` into `deploy.env`:

```bash
node scripts/coolify-wire-source.mjs    # → ✅ source wired: https://github.com/<owner>/liveplace-deploy.git
node scripts/coolify-deploy.mjs         # → guardrail → push env → deploy → smoke
```

The token is never printed and never stored in the remote URL or argv (git reads
it via a one-shot `GIT_ASKPASS` helper). Re-running re-pushes the latest tree.

**Manual fallback** (no PAT / different host), same secret-free bytes:

```bash
mkdir /tmp/lp && tar -xzf dist/liveplace-deploy.tar.gz -C /tmp/lp
cd /tmp/lp && git init -b main && git add -A && git commit -m "LivePlace deploy bundle"
git remote add origin <public-repo-url> && git push -u origin main
```

## What the deploy script does

`scripts/coolify-deploy.mjs` (zero deps, Node ≥ 22) runs the whole chain:

1. Loads `infra/coolify/deploy.env` (real env wins over the file).
2. Derives the full stack env — **anonymous mode by default**
   (`GATEWAY_AUTH_DISABLED=1`, no Twitch). `VITE_*` are flagged as build args;
   random secrets are generated if blank (and reported, so you persist them).
3. Creates the Docker-Compose app from the git source
   (`POST /api/v1/applications/public`, `build_pack=dockercompose`) — or reuses
   `COOLIFY_APP_UUID` if set (idempotent re-runs).
4. Pushes the env (`PATCH /api/v1/applications/{uuid}/envs/bulk`).
5. Triggers `GET /api/v1/deploy?uuid={uuid}&force=true` (instant deploy).
6. Polls `GET /api/v1/applications/{uuid}` until `running:healthy`.
7. Runs `scripts/smoke.mjs` against the public URL (`wss://<host>/ws`), aiming
   for `✅ SMOKE PASSED`.

**Dry-run is automatic without a token** — it prints the resolved env and the
exact API calls without touching the network, so the wiring is verifiable before
Phase B:

```bash
node scripts/coolify-deploy.mjs            # dry-run (no token)
node scripts/coolify-deploy.mjs --dry-run  # force dry-run even with a token
```

## Provisioning inputs (Phase B — from Alexis via the CEO)

Fill `infra/coolify/deploy.env` (copy from `.example`; gitignored). The values an
agent cannot self-supply:

| Input | Where it comes from |
|---|---|
| `COOLIFY_URL` + `COOLIFY_API_TOKEN` (deploy+write+read) | Alexis, on FEN-79 (Paperclip project vars), relayed by the CEO |
| `COOLIFY_PROJECT_UUID`, `COOLIFY_SERVER_UUID` | Read once from the Coolify UI/API |
| `COOLIFY_GIT_REPOSITORY` (+ `…_BRANCH`) | The public repo seeded from the bundle above |
| `PUBLIC_BASE_URL` | The FQDN routed to the stack (or leave blank to let Coolify autogenerate) |
| `CONVEX_SELF_HOSTED_ADMIN_KEY` | **One-time**, minted by the backend — see below |

Everything else the script generates or derives. Persist the generated
`CONVEX_INSTANCE_SECRET` / `BETTER_AUTH_SECRET` / `GATEWAY_INTERNAL_SECRET` in
Coolify so redeploys stay stable.

### The Convex admin key (the one non-obvious step)

The hot pixel path is Redis-only, but the gateway/worker are gated on the
`convex-deploy` one-shot completing, and `convex deploy` authenticates with
`CONVEX_SELF_HOSTED_ADMIN_KEY`. That key is **deterministic per
`CONVEX_INSTANCE_SECRET`** but is minted by the backend binary, so it cannot be
precomputed off-box. First deploy only:

1. Run the script once. The stack comes up; `convex-deploy` will fail without the
   key (gateway/worker stay down) — expected on first pass.
2. Mint the key against the running backend (Coolify UI terminal, or its exec):
   ```
   ./generate_admin_key.sh        # inside the convex-backend container
   ```
3. Paste it into `deploy.env` as `CONVEX_SELF_HOSTED_ADMIN_KEY` **and** keep the
   matching `CONVEX_INSTANCE_SECRET` (they are a bound pair — the script warns if
   the secret is blank while a key is set).
4. Re-run the script. `convex-deploy` succeeds → gateway/worker/web go healthy →
   smoke runs.

The key never changes for a given instance secret, so this is a one-time
provisioning step, not a per-deploy intervention.

## TLS / D5 — HTTPS Twitch callback

Coolify's own proxy terminates TLS at the edge and routes the public FQDN to the
stack, so the internal Caddy stays HTTP (`SITE_ADDRESS=:80`) and our compose does
**not** republish host 80/443 (`PROXY_HTTP_PORT/HTTPS_PORT` default to 8080/8443
to avoid colliding with Coolify's proxy). The public HTTPS callback
`${PUBLIC_BASE_URL}/api/auth/callback/twitch` is reachable through the Coolify
edge → internal Caddy `/api/auth*` → Convex site origin. **Verify against the live
instance:** that the public FQDN is bound to the `proxy` service (Coolify routes a
compose app's domain to a chosen service) — the one item only confirmable with
the running Coolify.

## Going from anonymous → real Twitch OAuth

Once the anon smoke is green: set `GATEWAY_AUTH_DISABLED=0`, fill
`TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`, set the Twitch console redirect URL
to `${PUBLIC_BASE_URL}/api/auth/callback/twitch`, re-run the script. The
authenticated smoke path (`TICKET=…`) is documented in `nas-deploy.md` §5.

## Rollback

- **Bad deploy:** Coolify keeps the previous build. Roll back from the UI, or
  redeploy a known-good commit: `git push` that commit and re-run the script (or
  `GET /api/v1/deploy?uuid={uuid}` pinned to the older commit).
- **Bad env:** re-`PATCH …/envs/bulk` with the previous values (re-run the script
  with the corrected `deploy.env`) and redeploy.
- **Full teardown:** stop/delete the application via the Coolify API/UI; volumes
  (redis-data, convex-data, caddy-*) persist unless explicitly removed.
- Blast radius is one Coolify application; the NAS path (`nas-deploy.md`) is
  independent and uses the same compose unchanged.
