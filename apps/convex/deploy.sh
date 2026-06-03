#!/bin/sh
# One-shot Convex deploy + deployment-env seeding for the self-hosted backend.
# Run by the compose `convex-deploy` service (apps/convex/Dockerfile) after
# convex-backend is healthy, then exits. FEN-69 boot seam; FEN-72 wires the F8
# moderation internal seam env (GATEWAY_INTERNAL_URL / GATEWAY_INTERNAL_SECRET).
#
# WHY this exists: on self-hosted Convex, the env vars functions read via
# `process.env.*` live IN the deployment (set with `convex env set`), NOT in the
# backend container's OS env. So `env_file: [.env]` on convex-backend never
# reaches functions — they must be pushed explicitly after deploy. This script
# is the single reproducible place that does it.
set -eu

cd /app/apps/convex

# 0a) Pick up the admin key minted in-stack by the `convex-admin-key` one-shot
#     (FEN-92), which writes it to the shared /admin volume. An explicit
#     CONVEX_SELF_HOSTED_ADMIN_KEY from the environment still wins. This is what
#     makes persistence agent-only: no manual `generate_admin_key.sh` terminal.
if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ] && [ -r /admin/admin_key ]; then
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /admin/admin_key 2>/dev/null || true)"
  export CONVEX_SELF_HOSTED_ADMIN_KEY
  if [ -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
    echo "[convex-deploy] loaded admin key from /admin/admin_key (minted in-stack by convex-admin-key)"
  fi
fi

# 0b) Bootstrap/anonymous mode: the self-hosted admin key is minted on-box, one
#    time, from CONVEX_INSTANCE_SECRET (`generate_admin_key.sh` in the
#    convex-backend container — now automated via the convex-admin-key service).
#    If it is STILL unavailable, `convex deploy` cannot authenticate. Rather than
#    hard-fail the one-shot — which gates gateway/worker via
#    `service_completed_successfully` and so fails the WHOLE stack — we SKIP
#    cleanly and exit 0. The Redis-only hot path (place/ack/broadcast) and the
#    anonymous WS smoke do not need deployed functions; the gateway's only Convex
#    use (gauge bonus) degrades to 0. Persistence + functions activate the moment
#    CONVEX_SELF_HOSTED_ADMIN_KEY is set and the stack is redeployed.
if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  echo "[convex-deploy] no CONVEX_SELF_HOSTED_ADMIN_KEY — anonymous/bootstrap mode:"
  echo "[convex-deploy]   skipping function deploy + env seeding (persistence disabled)."
  echo "[convex-deploy]   To enable: mint the key once via 'generate_admin_key.sh' in the"
  echo "[convex-deploy]   convex-backend container, set CONVEX_SELF_HOSTED_ADMIN_KEY, redeploy."
  exit 0
fi

# 1) Push the Convex functions into the self-hosted backend.
#    (Reads CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY from env.)
#    Soft-fail: if the deploy fails (wrong key format, backend unreachable, etc.)
#    we log and continue to exit 0. This keeps the `service_completed_successfully`
#    gate satisfied so gateway/worker start in all cases. Once the stack is
#    running:healthy, runtime logs reveal the actual error. Persistence activates
#    automatically when this step succeeds.
if ! pnpm exec convex deploy -y; then
  echo "[convex-deploy] WARNING: 'convex deploy' failed — stack will come up without deployed functions."
  echo "[convex-deploy]   Admin key may be wrong format, backend may have rejected it, or network issue."
  echo "[convex-deploy]   Gateway/worker will start in anonymous mode; read runtime logs to diagnose."
  exit 0
fi

# 2) Seed the deployment env vars the functions actually read (grep'd from
#    apps/convex/convex). Build a dotenv file from THIS container's env (supplied
#    via compose env_file), restricted to that allowlist, then push it in one
#    call. Only non-empty values are written, so a partial .env never clobbers
#    already-configured deployment vars. Secrets stay out of argv / process list.
ENV_TMP=".env.convex.$$"
: > "$ENV_TMP"
for name in \
  BETTER_AUTH_URL \
  CONVEX_SITE_URL \
  GATEWAY_INTERNAL_SECRET \
  GATEWAY_INTERNAL_URL \
  SITE_URL \
  TWITCH_CLIENT_ID \
  TWITCH_CLIENT_SECRET
do
  eval "val=\${$name:-}"
  if [ -n "$val" ]; then
    printf '%s=%s\n' "$name" "$val" >> "$ENV_TMP"
    echo "[convex-deploy] seed deployment env: $name"
  else
    echo "[convex-deploy] skip (unset): $name"
  fi
done

if [ -s "$ENV_TMP" ]; then
  pnpm exec convex env set --from-file "$ENV_TMP"
else
  echo "[convex-deploy] no deployment env to seed"
fi
rm -f "$ENV_TMP"

# 3) Seed the durable canvas row for the deployed slug (FEN-94). The worker seam
#    (applyFlush / setGalleryFields / recordSnapshot) is a no-op until a
#    `canvases` row exists (ADR-0001), and in anonymous mode (GATEWAY_AUTH_DISABLED=1)
#    there is no Twitch identity to run the public `createCanvas`. This privileged
#    one-shot (admin key already exported above) calls the idempotent internal
#    `canvases:ensureDefaultCanvas`, so the drain/restore + gallery path can be
#    exercised end-to-end (unblocks the FEN-89 live smoke). Geometry mirrors the
#    deployed gateway/Redis dims so `getCanvasDurable` restores the right bitmap.
#    Soft-fail: a failed seed must not gate the stack (service_completed_successfully).
SEED_SLUG="${GATEWAY_CANVAS_ID:-default}"
SEED_W="${CANVAS_WIDTH:-512}"
SEED_H="${CANVAS_HEIGHT:-512}"
echo "[convex-deploy] seed canvas row: slug=$SEED_SLUG ${SEED_W}x${SEED_H} (idempotent)"
if ! pnpm exec convex run canvases:ensureDefaultCanvas \
  "{\"slug\":\"$SEED_SLUG\",\"width\":$SEED_W,\"height\":$SEED_H}"; then
  echo "[convex-deploy] WARNING: ensureDefaultCanvas seed failed — drain/restore will no-op until a canvas row exists."
fi
