#!/usr/bin/env bash
# LivePlace — LOCAL UI-maquette preview on test-liveplace.nas (FEN-195, DevOps).
#
# One wrapper around docker-compose.preview.yml so the UI Designer / Dev Frontend
# can drive the OFF-production preview with a single command. This NEVER touches
# the production stack (docker-compose.yml / Coolify / liveplace.tv): it uses an
# isolated compose project (`liveplace-preview`).
#
# Usage (run on the NAS Docker executor — NOT Coolify):
#   scripts/preview-nas.sh up        # build/pull + start the preview edge
#   scripts/preview-nas.sh update    # rebuild web maquettes -> live on the preview
#   scripts/preview-nas.sh sync      # sync an already-built apps/web/dist -> preview
#   scripts/preview-nas.sh smoke     # curl /healthz + / on the local port
#   scripts/preview-nas.sh tunnel    # up + anonymous Cloudflare quick-tunnel (public URL, no DNS/token)
#   scripts/preview-nas.sh tunnel-url# print the current trycloudflare.com URL
#   scripts/preview-nas.sh status    # compose ps
#   scripts/preview-nas.sh logs      # follow preview logs
#   scripts/preview-nas.sh down      # stop & remove the preview stack
#
# Env:
#   PREVIEW_PORT   host port mapped to the preview edge (default 8088)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.preview.yml"
SITE_DIR="${REPO_ROOT}/preview/site"
DIST_DIR="${REPO_ROOT}/apps/web/dist"
PREVIEW_PORT="${PREVIEW_PORT:-8088}"

compose() { docker compose -f "${COMPOSE_FILE}" "$@"; }

sync_dist() {
  if [[ ! -d "${DIST_DIR}" || -z "$(ls -A "${DIST_DIR}" 2>/dev/null || true)" ]]; then
    echo "[preview] no build found at ${DIST_DIR} — run 'update' (or 'pnpm --filter @canvas/web build') first." >&2
    return 1
  fi
  echo "[preview] syncing ${DIST_DIR} -> ${SITE_DIR}"
  mkdir -p "${SITE_DIR}"
  # Clear previous content (keep the dir + its .gitignore), then copy the build.
  find "${SITE_DIR}" -mindepth 1 ! -name '.gitignore' -exec rm -rf {} + 2>/dev/null || true
  cp -a "${DIST_DIR}/." "${SITE_DIR}/"
  echo "[preview] preview/site now serves the latest maquette build."
}

cmd="${1:-help}"
case "${cmd}" in
  up)
    PREVIEW_PORT="${PREVIEW_PORT}" compose up -d
    echo "[preview] up. Local: http://localhost:${PREVIEW_PORT}/  (LAN: http://test-liveplace.nas:${PREVIEW_PORT}/ once DNS resolves)"
    ;;
  update)
    # Maquettes are the web SPA build. UI-only preview => no live backend needed,
    # so the public Convex origins are passed empty (build tolerates it, see
    # apps/web/Dockerfile). Designer/Frontend just rerun this after editing UI.
    echo "[preview] building web maquettes..."
    ( cd "${REPO_ROOT}" && VITE_CONVEX_URL="" VITE_CONVEX_SITE_URL="" pnpm --filter @canvas/web build )
    sync_dist
    PREVIEW_PORT="${PREVIEW_PORT}" compose up -d
    echo "[preview] updated. Reload http://test-liveplace.nas:${PREVIEW_PORT}/ to see the new maquettes."
    ;;
  sync)
    sync_dist
    ;;
  smoke)
    base="http://localhost:${PREVIEW_PORT}"
    echo "[preview] GET ${base}/healthz"; curl -fsS "${base}/healthz" && echo
    echo "[preview] GET ${base}/ (first line)"; curl -fsS "${base}/" | head -1
    echo "[preview] smoke OK"
    ;;
  tunnel)
    # Bring up the preview + an anonymous Cloudflare quick-tunnel (no token, no
    # DNS, no inbound port). Public https://<random>.trycloudflare.com URL, stays
    # up as long as this (persistent) host runs the container. Read it from logs.
    PREVIEW_PORT="${PREVIEW_PORT}" compose --profile tunnel up -d
    echo "[preview] tunnel up. Public URL (give it a few seconds, then):"
    echo "  scripts/preview-nas.sh tunnel-url"
    ;;
  tunnel-url)
    compose logs cloudflared 2>/dev/null | grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' | tail -1 \
      || echo "[preview] no tunnel URL yet — is the tunnel profile up? (scripts/preview-nas.sh tunnel)"
    ;;
  status) compose ps ;;
  logs)   compose logs -f --tail=100 ;;
  down)   compose down ;;
  help|*)
    sed -n '2,21p' "${BASH_SOURCE[0]}"
    ;;
esac
