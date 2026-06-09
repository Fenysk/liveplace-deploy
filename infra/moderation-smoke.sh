#!/bin/sh
# F8 moderation internal-seam smoke (FEN-72). Verifies the gateway guards its
# POST /internal/{moderate,ban,freeze,flush} routes exactly as the contract
# (docs/contracts/moderation-internal.md) and apps/gateway/src/gateway.ts
# (handleModerationRoute) specify:
#   - GATEWAY_INTERNAL_SECRET unset on the gateway -> 404 (whole seam disabled)
#   - secret set, missing/wrong Bearer             -> 401 (unauthorized)
#   - secret set, correct Bearer                   -> routed (never 401/404; a
#                                                     bad body is the caller's 400)
#
# Run against a deployed gateway (part of the runtime smoke). Needs curl.
#   GATEWAY_BASE_URL   base URL of the gateway      (default http://localhost:8080)
#   GATEWAY_INTERNAL_SECRET  the shared secret the gateway was started with
#                            (leave empty to assert the seam-disabled 404 case)
set -eu

BASE="${GATEWAY_BASE_URL:-http://localhost:8080}"
SECRET="${GATEWAY_INTERNAL_SECRET:-}"
ROUTES="moderate ban freeze flush"
fail=0

# code <route> [authorization-header-value]
code() {
  if [ -n "${2:-}" ]; then
    curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/internal/$1" \
      -H "content-type: application/json" -H "authorization: $2" -d '{}'
  else
    curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/internal/$1" \
      -H "content-type: application/json" -d '{}'
  fi
}

for r in $ROUTES; do
  if [ -z "$SECRET" ]; then
    c=$(code "$r")
    if [ "$c" = 404 ]; then echo "ok   /internal/$r: seam disabled -> 404"
    else echo "FAIL /internal/$r: expected 404 (no secret), got $c"; fail=1; fi
  else
    c=$(code "$r")
    [ "$c" = 401 ] || { echo "FAIL /internal/$r: missing Bearer expected 401, got $c"; fail=1; }
    c=$(code "$r" "Bearer wrong-$SECRET")
    [ "$c" = 401 ] || { echo "FAIL /internal/$r: wrong Bearer expected 401, got $c"; fail=1; }
    c=$(code "$r" "Bearer $SECRET")
    case "$c" in
      401|404) echo "FAIL /internal/$r: correct Bearer still rejected ($c)"; fail=1 ;;
      *)       echo "ok   /internal/$r: guarded (401 without, $c with Bearer)" ;;
    esac
  fi
done

if [ "$fail" = 0 ]; then echo "moderation seam smoke: PASS"; else echo "moderation seam smoke: FAIL"; exit 1; fi
