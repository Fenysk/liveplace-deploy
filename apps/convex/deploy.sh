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
#
#     FEN-96: convex-deploy now orders on convex-admin-key via `service_started`
#     (not `service_completed_successfully`, which propagated the one-shot's exit
#     code into `docker compose up -d` and failed the deploy). So the keyfile may
#     not exist the instant we start — poll the shared volume briefly for a
#     NON-EMPTY key before falling back to anonymous mode. Bounded so a genuinely
#     absent key (mint failed → empty keyfile) still degrades cleanly to
#     anonymous/persistence-off rather than hanging the boot.
if [ -z "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ]; then
  _waited=0
  while [ "$_waited" -lt 30 ]; do
    if [ -s /admin/admin_key ]; then
      CONVEX_SELF_HOSTED_ADMIN_KEY="$(cat /admin/admin_key 2>/dev/null || true)"
      export CONVEX_SELF_HOSTED_ADMIN_KEY
      [ -n "${CONVEX_SELF_HOSTED_ADMIN_KEY:-}" ] && \
        echo "[convex-deploy] loaded admin key from /admin/admin_key (minted in-stack by convex-admin-key, after ${_waited}s)"
      break
    fi
    sleep 2
    _waited=$((_waited + 2))
  done
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
  echo "[convex-deploy] WARNING: 'convex deploy' failed — stack will come up without freshly deployed functions."
  echo "[convex-deploy]   Admin key may be wrong format, backend may have rejected it, or network issue."
  echo "[convex-deploy]   NOT exiting (FEN-91): deployment-env seeding below only needs the admin key, not a"
  echo "[convex-deploy]   successful function deploy — so still seed env (incl. BETTER_AUTH_SECRET) so a"
  echo "[convex-deploy]   transient deploy hiccup can't leave auth on the better-auth DEFAULT secret."
fi

# 2) Seed the deployment env vars the functions actually read (grep'd from
#    apps/convex/convex). Build a dotenv file from THIS container's env (supplied
#    via compose env_file), restricted to that allowlist, then push it in one
#    call. Only non-empty values are written, so a partial .env never clobbers
#    already-configured deployment vars. Secrets stay out of argv / process list.
ENV_TMP=".env.convex.$$"
: > "$ENV_TMP"
for name in \
  BETTER_AUTH_SECRET \
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
    SEED_REPORT="${SEED_REPORT:-}${name}:set,"
  else
    echo "[convex-deploy] skip (unset): $name"
    SEED_REPORT="${SEED_REPORT:-}${name}:UNSET,"
  fi
done

if [ -s "$ENV_TMP" ]; then
  # FEN-98: soft-fail the bulk seed. Under `set -eu` an unguarded non-zero here
  # ABORTS the whole script before the instrument (2a) and the individual
  # BETTER_AUTH_SECRET re-seed (2b) can run — observed live: 6 vars seeded but
  # `diag.authEnvStatus.seedReport` came back null and BETTER_AUTH_SECRET stayed
  # DEFAULT, i.e. the script died right here. `convex env set --from-file` can
  # exit non-zero even after writing some vars (e.g. it rejects one key), so a
  # single bad entry must NOT prevent the per-var re-seed + the diagnostic from
  # running. Same soft-fail philosophy already applied to `convex deploy` above.
  if ! pnpm exec convex env set --from-file "$ENV_TMP"; then
    echo "[convex-deploy] WARNING: bulk 'convex env set --from-file' returned non-zero"
    echo "[convex-deploy]   — continuing to the per-var re-seed + DIAG_SEED_REPORT instrument below."
  fi
else
  echo "[convex-deploy] no deployment env to seed"
fi
rm -f "$ENV_TMP"

# 2a) FEN-98 instrument + belt-and-suspenders for BETTER_AUTH_SECRET.
#     SYMPTOM (proven by diag.authEnvStatus): only BETTER_AUTH_SECRET fails to
#     reach the functions runtime — its 6 siblings (incl. TWITCH_CLIENT_SECRET)
#     seed fine. Value-formatting and the Coolify env-record were both ruled out
#     from outside the box. The one link nobody could observe is whether
#     BETTER_AUTH_SECRET is even NON-EMPTY *inside this convex-deploy container*
#     at seed time (no exec API; the one-shot's runtime stdout isn't in Coolify's
#     build-phase log). So make the decision observable AND defend it:
#
#   (a) Publish DIAG_SEED_REPORT = "NAME:set,NAME:UNSET,…" (names + coarse flag
#       ONLY, never values) as its own one-var dotenv push. diag.authEnvStatus
#       surfaces it, so one redeploy tells us, for THIS container's env:
#         - BETTER_AUTH_SECRET:UNSET  => the var never reached the container .env
#           (Coolify/env_file materialization gap — e.g. a duplicate/preview entry
#           emitting an empty last-wins line). deploy.sh cannot conjure a value;
#           fix is on the Coolify env (DevOps), now with hard proof.
#         - BETTER_AUTH_SECRET:set but diag betterAuthSecret:"DEFAULT" => the bulk
#           `--from-file` push dropped it; (b) below already works around that.
#       Pushed via its OWN from-file (not argv) so it stays secret-safe AND so a
#       successful push also proves the from-file code path itself works.
#
#   (b) If BETTER_AUTH_SECRET is present in this container's env, push it AGAIN on
#       its own (dedicated one-var from-file, still out of argv). A bulk
#       multi-line `--from-file` edge case that silently skips one entry then
#       can't leave auth on the default secret. Harmless if already seeded.
REPORT_TMP=".env.report.$$"
printf 'DIAG_SEED_REPORT=%s\n' "${SEED_REPORT:-}" > "$REPORT_TMP"
if ! pnpm exec convex env set --from-file "$REPORT_TMP"; then
  echo "[convex-deploy] WARNING: could not push DIAG_SEED_REPORT (instrument only)"
fi
rm -f "$REPORT_TMP"

if [ -n "${BETTER_AUTH_SECRET:-}" ]; then
  BAS_TMP=".env.bas.$$"
  printf 'BETTER_AUTH_SECRET=%s\n' "$BETTER_AUTH_SECRET" > "$BAS_TMP"
  if pnpm exec convex env set --from-file "$BAS_TMP"; then
    echo "[convex-deploy] re-seeded BETTER_AUTH_SECRET individually (belt-and-suspenders)"
  else
    echo "[convex-deploy] WARNING: individual BETTER_AUTH_SECRET re-seed failed"
  fi
  rm -f "$BAS_TMP"
else
  echo "[convex-deploy] BETTER_AUTH_SECRET UNSET in container env — cannot seed (see DIAG_SEED_REPORT; fix the Coolify env, FEN-98)"
fi

# 2c) FEN-100 — the OAuth base URL hit the SAME bulk-drop as BETTER_AUTH_SECRET.
#     diag.authEnvStatus proved the functions runtime served a stale sslip
#     BETTER_AUTH_URL while Coolify + this container's env already held
#     https://liveplace.tv, i.e. the bulk `convex env set --from-file` (2) silently
#     dropped BETTER_AUTH_URL's updated value (same multi-line skip that dropped the
#     secret). auth.ts:27 derives the OAuth `redirect_uri` from
#     `SITE_URL ?? BETTER_AUTH_URL`, so a stale base = Twitch rejects login e2e.
#     Re-seed BOTH individually, ONE var per `--from-file` (the proven non-drop
#     path used for BETTER_AUTH_SECRET above), so redirect_uri tracks the real
#     public origin. SITE_URL is not in the coolify-deploy stack, so default it to
#     the (now correct) BETTER_AUTH_URL to make auth.ts's precedence deterministic.
AUTH_BASE="${SITE_URL:-${BETTER_AUTH_URL:-}}"
if [ -n "$AUTH_BASE" ]; then
  for AKEY in BETTER_AUTH_URL SITE_URL; do
    AURL_TMP=".env.${AKEY}.$$"
    printf '%s=%s\n' "$AKEY" "$AUTH_BASE" > "$AURL_TMP"
    if pnpm exec convex env set --from-file "$AURL_TMP"; then
      echo "[convex-deploy] re-seeded $AKEY individually = $AUTH_BASE (belt-and-suspenders, FEN-100)"
    else
      echo "[convex-deploy] WARNING: individual $AKEY re-seed failed"
    fi
    rm -f "$AURL_TMP"
  done
else
  echo "[convex-deploy] BETTER_AUTH_URL/SITE_URL UNSET in container env — cannot seed auth base (fix Coolify PUBLIC_BASE_URL, FEN-100)"
fi

# 2d) FEN-527 — PROD P0: Twitch login broke with an EMPTY client_id
#     (id.twitch.tv → {"status":400,"message":"missing client id"}). The
#     redirect_uri was correct, so prod built the URL but auth.ts read an empty
#     process.env.TWITCH_CLIENT_ID — i.e. the var never reached the functions
#     runtime. This is the SAME bulk `convex env set --from-file` multi-line skip
#     that previously dropped BETTER_AUTH_SECRET (FEN-98) and BETTER_AUTH_URL
#     (FEN-100); TWITCH_CLIENT_ID/SECRET were the only auth-critical vars still
#     relying solely on the fragile bulk push. Give them the proven non-drop path
#     too: re-seed each individually via its own one-var `--from-file` (secret
#     stays out of argv). Harmless no-op if the bulk push already landed them.
for TKEY in TWITCH_CLIENT_ID TWITCH_CLIENT_SECRET; do
  eval "tval=\${$TKEY:-}"
  if [ -n "$tval" ]; then
    T_TMP=".env.${TKEY}.$$"
    printf '%s=%s\n' "$TKEY" "$tval" > "$T_TMP"
    if pnpm exec convex env set --from-file "$T_TMP"; then
      echo "[convex-deploy] re-seeded $TKEY individually (belt-and-suspenders, FEN-527)"
    else
      echo "[convex-deploy] WARNING: individual $TKEY re-seed failed"
    fi
    rm -f "$T_TMP"
  else
    echo "[convex-deploy] $TKEY UNSET in container env — cannot seed (fix the Coolify env, FEN-527)"
  fi
done

# 2e) FEN-698: GATEWAY_INTERNAL_SECRET guards the worker:run action used by the
#     persistence worker (applyFlush). An incorrect or missing secret causes
#     "worker:run unauthorized" on every drain tick → totalPixels=0 forever.
#     Same bulk-drop risk as FEN-98/100/527 — give it the proven one-var path too.
if [ -n "${GATEWAY_INTERNAL_SECRET:-}" ]; then
  GIS_TMP=".env.gis.$$"
  printf 'GATEWAY_INTERNAL_SECRET=%s\n' "$GATEWAY_INTERNAL_SECRET" > "$GIS_TMP"
  if pnpm exec convex env set --from-file "$GIS_TMP"; then
    echo "[convex-deploy] re-seeded GATEWAY_INTERNAL_SECRET individually (belt-and-suspenders, FEN-698)"
  else
    echo "[convex-deploy] WARNING: individual GATEWAY_INTERNAL_SECRET re-seed failed"
  fi
  rm -f "$GIS_TMP"
else
  echo "[convex-deploy] GATEWAY_INTERNAL_SECRET UNSET — worker:run will reject all persistence calls (fix Coolify env, FEN-698)"
fi

# 3) FEN-433 (AC-2/B5): ensureDefaultCanvas removed — personal canvases are
#    created automatically on first auth (account.onCreate trigger). The
#    anonymous-mode seed is no longer needed; canvas rows are user-owned.

# 4) FEN-435 (AC-5 cutover): seed the SYSTEM palette idempotently on every deploy.
#    createCanvas (canvases.ts) THROWS "default palette missing" when the
#    ownerId==null palette row is absent — and nothing else seeds it. On a fresh
#    DB (e.g. the cutover flush, which starts the stack on empty Convex/Redis
#    volumes) the very first personal-canvas creation on first auth (AC-1) would
#    fail without this. ensureDefaultPalette is idempotent (returns the existing
#    row if present), so this is a harmless no-op on an already-seeded DB and a
#    REQUIRED seed on a flushed one. Soft-fail like the steps above so a transient
#    hiccup can't fail the whole one-shot (the stack still serves; logs reveal it).
if pnpm exec convex run palettes:ensureDefaultPalette >/dev/null 2>&1; then
  echo "[convex-deploy] seeded system default palette (palettes:ensureDefaultPalette, FEN-435)"
else
  echo "[convex-deploy] WARNING: palettes:ensureDefaultPalette seed failed — first canvas creation may error until re-run (FEN-435)"
fi
