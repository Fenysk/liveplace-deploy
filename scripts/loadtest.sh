#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/loadtest.sh — drive the DISPOSABLE load-test stack (FEN-511 / T3).
#
#   ⚠️  NEVER PRODUCTION. This wrapper only ever touches the `liveplace-loadtest`
#       compose project (docker-compose.loadtest.yml + .env.loadtest). It cannot
#       reach a prod stack: it never reads `.env`, never names the prod project,
#       and refuses to run if .env.loadtest looks like it points at prod.
#
# Usage — SINGLE-CANVAS stack (mono-canvas ceiling, FEN-511):
#   ./scripts/loadtest.sh up       # build + start the isolated chain (detached)
#   ./scripts/loadtest.sh smoke     # WS live-pixel smoke against the test gateway
#   ./scripts/loadtest.sh logs      # follow logs
#   ./scripts/loadtest.sh ps        # status
#   ./scripts/loadtest.sh config    # render merged compose (validation, no run)
#   ./scripts/loadtest.sh down      # stop (KEEPS the disposable volumes)
#   ./scripts/loadtest.sh clean     # down -v: stop AND DELETE the throwaway data
#
# Usage — MULTI-CANVAS fanout (20 toiles × 500 = 10 000 conns, FEN-516):
#   The single-canvas stack pins ONE gateway + ONE worker to ONE canvas, so it can
#   only drive a mono-canvas ceiling. The fanout stack generates N distinct
#   gateways + N workers (canvas loadtest-<i>, distinct host ports) over one shared
#   Redis + Convex, so the 20-toiles target can be driven as 20 REAL canvases.
#   ./scripts/loadtest.sh fanout-gen [N] [BASE_PORT]  # (re)generate the N-canvas compose (default 20 / 8100)
#   ./scripts/loadtest.sh fanout-up  [N] [BASE_PORT]  # regen + build + start the fanout stack
#   ./scripts/loadtest.sh fanout-smoke                # WS smoke against EVERY fanout gateway
#   ./scripts/loadtest.sh fanout-targets              # print TARGET_URLS for the campaign runner (FEN-512)
#   ./scripts/loadtest.sh fanout-ps | fanout-logs | fanout-config
#   ./scripts/loadtest.sh fanout-down | fanout-clean  # stop / down -v the fanout stack
#
# See docs/runbooks/loadtest-env.md.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

PROJECT="liveplace-loadtest"
COMPOSE_FILE="docker-compose.loadtest.yml"
ENV_FILE=".env.loadtest"

# Fanout (multi-canvas) project — separate name so its volumes/network can never
# collide with the single-canvas stack or prod. Same .env.loadtest (guard-railed).
FANOUT_PROJECT="liveplace-loadtest-fanout"
FANOUT_FILE="docker-compose.loadtest.fanout.yml"
FANOUT_TARGETS=".env.loadtest-fanout-targets"

compose() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }
fcompose() { docker compose -p "$FANOUT_PROJECT" -f "$FANOUT_FILE" --env-file "$ENV_FILE" "$@"; }

# (Re)generate the fanout compose + targets from the source-of-truth generator.
fanout_gen() {
  local n="${1:-20}" base="${2:-8100}"
  node scripts/loadtest-fanout.mjs --canvases "$n" --base-port "$base"
}

ensure_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "→ $ENV_FILE missing; creating it from .env.loadtest.example" >&2
    cp .env.loadtest.example "$ENV_FILE"
    echo "  (edit $ENV_FILE if you want a relaxed/raw-ceiling gauge — see the file)" >&2
  fi
  # Guardrail: refuse to run if the env file smells like a real deployment. The
  # load stack must never reach a prod domain / prod Convex.
  if grep -qiE '^(PUBLIC_SITE_URL|BETTER_AUTH_URL|VITE_CONVEX_URL)=https://(liveplace\.tv|canvas\.)' "$ENV_FILE"; then
    echo "✗ REFUSING TO RUN: $ENV_FILE references a production URL." >&2
    echo "  The load-test stack is disposable and must never point at prod." >&2
    exit 2
  fi
  if ! grep -qE '^GATEWAY_CANVAS_ID=loadtest-' "$ENV_FILE"; then
    echo "✗ REFUSING TO RUN: GATEWAY_CANVAS_ID must be a loadtest-* slug in $ENV_FILE." >&2
    exit 2
  fi
}

cmd="${1:-}"
case "$cmd" in
  up)
    ensure_env
    echo "→ Building + starting the disposable load-test stack ($PROJECT)…" >&2
    compose up -d --build
    echo "→ Up. Gateway published on host port \${LOADTEST_GATEWAY_PORT:-8080}." >&2
    echo "  Smoke it:   ./scripts/loadtest.sh smoke" >&2
    echo "  Tear down:  ./scripts/loadtest.sh clean   (deletes disposable data)" >&2
    ;;
  smoke)
    ensure_env
    # Reuse the canonical WS smoke against the raw gateway. No proxy / no web in the
    # load stack, so skip the web probe (empty WEB_URL) and hit the gateway directly.
    port="$(grep -E '^LOADTEST_GATEWAY_PORT=' "$ENV_FILE" | tail -1 | cut -d= -f2)"; port="${port:-8080}"
    WEB_URL="" \
    GATEWAY_HTTP_URL="http://localhost:${port}" \
    GATEWAY_WS_URL="ws://localhost:${port}" \
      node scripts/smoke.mjs
    ;;
  down)    compose down ;;
  clean)   compose down -v ;;            # DELETES redis-data / convex-data-2 / convex-admin
  logs)    compose logs -f --tail=200 ;;
  ps)      compose ps ;;
  config)  ensure_env; compose config ;;

  # ── MULTI-CANVAS FANOUT (FEN-516) ──────────────────────────────────────────
  fanout-gen)
    fanout_gen "${2:-}" "${3:-}"
    ;;
  fanout-up)
    ensure_env
    fanout_gen "${2:-}" "${3:-}"
    echo "→ Building + starting the FANOUT load-test stack ($FANOUT_PROJECT)…" >&2
    echo "  (one gateway+worker per canvas; this is heavy — run it on a beefy box)" >&2
    fcompose up -d --build
    echo "→ Up. Per-canvas gateways published; campaign targets in $FANOUT_TARGETS." >&2
    echo "  Smoke them:   ./scripts/loadtest.sh fanout-smoke" >&2
    echo "  Targets:      ./scripts/loadtest.sh fanout-targets" >&2
    echo "  Tear down:    ./scripts/loadtest.sh fanout-clean   (deletes disposable data)" >&2
    ;;
  fanout-smoke)
    ensure_env
    if [[ ! -f "$FANOUT_TARGETS" ]]; then
      echo "✗ $FANOUT_TARGETS missing — run ./scripts/loadtest.sh fanout-gen first." >&2
      exit 2
    fi
    # WS smoke EVERY per-canvas gateway so a 20-canvas run is proven end-to-end,
    # not just canvas 0. Derives host ports from the generated TARGET_URLS line.
    urls="$(grep -E '^TARGET_URLS=' "$FANOUT_TARGETS" | tail -1 | cut -d= -f2)"
    IFS=',' read -ra arr <<< "$urls"
    fail=0
    for u in "${arr[@]}"; do
      port="${u##*:}"
      echo "→ smoke ws://localhost:${port} (canvas loadtest-$(( port - 8100 )))" >&2
      if WEB_URL="" GATEWAY_HTTP_URL="http://localhost:${port}" GATEWAY_WS_URL="ws://localhost:${port}" \
           node scripts/smoke.mjs; then :; else fail=1; echo "  ✗ FAILED on port ${port}" >&2; fi
    done
    [[ $fail -eq 0 ]] && echo "✓ all ${#arr[@]} fanout gateways smoked green" >&2
    exit $fail
    ;;
  fanout-targets)
    if [[ -f "$FANOUT_TARGETS" ]]; then grep -E '^TARGET_URLS=' "$FANOUT_TARGETS";
    else echo "✗ $FANOUT_TARGETS missing — run ./scripts/loadtest.sh fanout-gen first." >&2; exit 2; fi
    ;;
  fanout-down)   fcompose down ;;
  fanout-clean)  fcompose down -v ;;
  fanout-logs)   fcompose logs -f --tail=200 ;;
  fanout-ps)     fcompose ps ;;
  fanout-config) ensure_env; [[ -f "$FANOUT_FILE" ]] || fanout_gen; fcompose config ;;
  ""|-h|--help|help)
    sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//'
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    echo "  single-canvas: up | smoke | logs | ps | config | down | clean" >&2
    echo "  fanout (FEN-516): fanout-gen | fanout-up | fanout-smoke | fanout-targets |" >&2
    echo "                    fanout-ps | fanout-logs | fanout-config | fanout-down | fanout-clean" >&2
    exit 1
    ;;
esac
