#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# nas-deploy.sh — bring the LivePlace *TEST* stack up on the shared NAS (FEN-523).
#
# Idempotent: rsync the repo to the NAS, then `docker compose -p liveplace-test`
# up --build with the test overlay, health-check, and (optionally) front it with
# Tailscale Serve HTTPS. Prod (liveplace.tv on Coolify) is NEVER touched.
#
# Usage:
#   NAS_SSH_KEY="$NAS_SSH_KEY" ./scripts/nas-deploy.sh up        # build + start
#   ./scripts/nas-deploy.sh down                                 # stop (keep vols)
#   ./scripts/nas-deploy.sh nuke                                 # stop + drop vols
#   ./scripts/nas-deploy.sh smoke                                # health checks only
#
# Required inputs (env or defaults):
#   NAS_SSH_KEY   — private key for paperclip@NAS. Newlines may be flattened to
#                   spaces by the secret store (FEN-522/523); this script REBUILDS
#                   a valid PEM regardless (self-heal). Preferred long-term fix is
#                   to store the key with real newlines / base64 at the source.
#   NAS_HOST      — default 192.168.1.98 (LAN); falls back to Tailscale IP.
#   NAS_USER      — default paperclip
#   NAS_DIR       — default /home/paperclip/deploy/liveplace-test
#   TS_HOSTNAME   — if set, run `tailscale serve` to front the stack over HTTPS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CMD="${1:-up}"
NAS_HOST="${NAS_HOST:-192.168.1.98}"
NAS_HOST_FALLBACK="${NAS_HOST_FALLBACK:-100.74.250.38}"  # Tailscale IP (FEN-522)
NAS_USER="${NAS_USER:-paperclip}"
NAS_DIR="${NAS_DIR:-/home/paperclip/deploy/liveplace-test}"
PROJECT="liveplace-test"
PROXY_PORT="${PROXY_HTTP_PORT:-8091}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\033[1;36m[nas-deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[nas-deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# ── 1. Reconstruct a valid PEM from NAS_SSH_KEY (self-heal flattened newlines) ──
# The secret store flattens the key's line breaks to spaces (FEN-522). A PEM is
# header + base64 body + footer; we restore newlines so ssh/rsync accept it. Works
# whether the source value already has real newlines (left untouched) or not.
prepare_key() {
  [ -n "${NAS_SSH_KEY:-}" ] || die "NAS_SSH_KEY is not set in the environment. \
This script needs the paperclip@NAS private key injected to reach the NAS."
  KEYFILE="$(mktemp)"; chmod 600 "$KEYFILE"
  trap 'rm -f "$KEYFILE"' EXIT
  if printf '%s' "$NAS_SSH_KEY" | grep -q $'\n'; then
    # Already multi-line — use as-is.
    printf '%s\n' "$NAS_SSH_KEY" > "$KEYFILE"
  else
    # Single line with spaces: split header/footer from the base64 body and
    # re-wrap. Handles OpenSSH and RSA/EC PEM headers.
    python3 - "$KEYFILE" <<'PY'
import os, re, sys
raw = os.environ["NAS_SSH_KEY"].strip()
m = re.match(r"(-----BEGIN [A-Z0-9 ]+-----)\s+(.*?)\s+(-----END [A-Z0-9 ]+-----)\s*$", raw, re.S)
if not m:
    sys.exit("NAS_SSH_KEY does not look like a PEM (no BEGIN/END markers)")
header, body, footer = m.group(1), m.group(2), m.group(3)
body = re.sub(r"\s+", "", body)              # strip the flattened spaces
wrapped = "\n".join(body[i:i+64] for i in range(0, len(body), 64))
open(sys.argv[1], "w").write(f"{header}\n{wrapped}\n{footer}\n")
PY
  fi
  # Validate before we lean on it.
  ssh-keygen -y -f "$KEYFILE" >/dev/null 2>&1 || die "Reconstructed key is invalid PEM"
  log "PEM reconstructed and validated."
}

ssh_nas() { ssh -i "$KEYFILE" -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
  -o ConnectTimeout=8 "${NAS_USER}@${ACTIVE_HOST}" "$@"; }

pick_host() {
  for h in "$NAS_HOST" "$NAS_HOST_FALLBACK"; do
    if timeout 6 bash -c "cat < /dev/null > /dev/tcp/$h/22" 2>/dev/null; then
      ACTIVE_HOST="$h"; log "NAS reachable on $h:22"; return 0
    fi
  done
  die "NAS unreachable on $NAS_HOST and $NAS_HOST_FALLBACK (port 22)."
}

COMPOSE=(docker compose -p "$PROJECT" \
  -f docker-compose.yml \
  -f deploy/nas/liveplace-test/docker-compose.test.yml \
  --env-file .env)

sync_repo() {
  ssh_nas "mkdir -p '$NAS_DIR'"
  log "rsync repo -> ${NAS_USER}@${ACTIVE_HOST}:${NAS_DIR}"
  rsync -az --delete \
    --exclude '.git' --exclude 'node_modules' --exclude 'dist' \
    --exclude '.env' --exclude '*.local' \
    -e "ssh -i '$KEYFILE' -o BatchMode=yes -o StrictHostKeyChecking=accept-new" \
    "$REPO_ROOT/" "${NAS_USER}@${ACTIVE_HOST}:${NAS_DIR}/"
  # The stack .env is provisioned out-of-band on the NAS (secrets, never in repo).
  ssh_nas "test -f '$NAS_DIR/.env'" \
    || die "No $NAS_DIR/.env on the NAS. Copy .env.test.example -> .env (chmod 600), fill secrets."
}

remote_compose() { ssh_nas "cd '$NAS_DIR' && ${COMPOSE[*]} $*"; }

smoke() {
  log "Pre-flight: arch / free ports / disk / tenants"
  ssh_nas "uname -m; echo '--- ports ---'; ss -ltn | grep -E ':(8090|8091)\b' || true; \
           echo '--- disk ---'; df -h '$NAS_DIR' | tail -1; \
           echo '--- containers ---'; docker ps --format '{{.Names}}\t{{.Status}}'"
  log "Health: proxy on 127.0.0.1:${PROXY_PORT}"
  ssh_nas "curl -fsS -m 5 http://127.0.0.1:${PROXY_PORT}/healthz && echo ' OK /healthz'" \
    || log "WARN /healthz not green yet"
}

case "$CMD" in
  up)
    prepare_key; pick_host; sync_repo
    log "docker compose up -d --build (project=$PROJECT)"
    remote_compose up -d --build
    log "Waiting for proxy health…"
    for i in $(seq 1 24); do
      if ssh_nas "curl -fsS -m 4 http://127.0.0.1:${PROXY_PORT}/healthz" >/dev/null 2>&1; then
        log "proxy healthy."; break
      fi; sleep 5
      [ "$i" = 24 ] && log "WARN proxy still not healthy after 120s — inspect logs."
    done
    if [ -n "${TS_HOSTNAME:-}" ]; then
      log "tailscale serve HTTPS -> 127.0.0.1:${PROXY_PORT}"
      ssh_nas "tailscale serve --bg --https=443 http://127.0.0.1:${PROXY_PORT}" \
        || log "WARN tailscale serve failed (run manually with sudo if needed)."
    fi
    smoke
    log "Done. Preview: https://${TS_HOSTNAME:-<set TS_HOSTNAME>}/"
    ;;
  down) prepare_key; pick_host; remote_compose down ;;
  nuke) prepare_key; pick_host; remote_compose down -v ;;
  smoke) prepare_key; pick_host; smoke ;;
  *) die "unknown command: $CMD (use up|down|nuke|smoke)" ;;
esac
