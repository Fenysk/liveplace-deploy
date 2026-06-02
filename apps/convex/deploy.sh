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

# 1) Push the Convex functions into the self-hosted backend.
#    (Reads CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY from env.)
pnpm exec convex deploy -y

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
