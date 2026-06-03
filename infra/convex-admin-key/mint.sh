#!/bin/sh
# mint.sh — one-shot Convex admin-key mint for the in-stack agent-only flow (FEN-92).
# Baked into the convex-admin-key image (infra/convex-admin-key/Dockerfile) which
# is based on the convex-backend image so generate_admin_key.sh is always present.
#
# Writes the minted key to /admin/admin_key on the shared convex-admin volume.
# convex-deploy (apps/convex/deploy.sh) reads the key from that volume.
#
# ALWAYS exits 0: if the key cannot be minted for any reason, leaves the keyfile
# empty so convex-deploy gracefully skips function deployment (anonymous mode).
# A missing key means "no persistence" not a dead stack.
set -u

KEYFILE=/admin/admin_key

# An operator-supplied key wins; forward it and we're done.
if [ -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  printf '%s' "$CONVEX_SELF_HOSTED_ADMIN_KEY" > "$KEYFILE"
  echo "[mint] forwarded operator-supplied CONVEX_SELF_HOSTED_ADMIN_KEY"
  exit 0
fi

# Locate generate_admin_key.sh (shipped in the convex-backend image).
# The image WORKDIR is typically /convex or /, so try common locations.
SCRIPT=""
for p in \
  ./generate_admin_key.sh \
  /generate_admin_key.sh \
  /convex/generate_admin_key.sh \
  /app/generate_admin_key.sh; do
  if [ -x "$p" ]; then
    SCRIPT="$p"
    break
  fi
done

if [ -z "$SCRIPT" ]; then
  echo "[mint] generate_admin_key.sh not found in image paths — anonymous mode (no persistence)"
  : > "$KEYFILE"
  exit 0
fi

# Run the script; it reads INSTANCE_NAME and INSTANCE_SECRET from the environment.
# The output format is: <instance_name>|<encrypted_bytes>
# Capture stdout only (2>/dev/null suppresses setup chatter).
OUT=$("$SCRIPT" 2>/dev/null || true)

# Extract the key line: must start with alphanumeric/hyphen chars followed by '|'.
KEY=$(printf '%s\n' "$OUT" | grep -E '^[A-Za-z0-9_-]+[|]' | tail -n1)
if [ -z "$KEY" ]; then
  # Fallback: any line containing '|' (less strict, catches other output formats).
  KEY=$(printf '%s\n' "$OUT" | grep '[|]' | tail -n1)
fi

if [ -z "$KEY" ]; then
  echo "[mint] script produced no recognisable key — anonymous mode. raw output:"
  printf '%s\n' "$OUT" | head -5
  : > "$KEYFILE"
  exit 0
fi

printf '%s' "$KEY" > "$KEYFILE"
echo "[mint] admin key written to $KEYFILE ($(wc -c < "$KEYFILE") bytes)"
