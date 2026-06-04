#!/usr/bin/env bash
# LivePlace — DOCKERLESS agent path to publish the UI maquettes preview over a
# public HTTPS Cloudflare quick-tunnel (FEN-195 / FEN-196, DevOps).
#
# WHY this exists alongside scripts/preview-nas.sh:
#   The runbook's `tunnel` uses a docker `cloudflared` container. The Paperclip
#   agent executor has NO docker. This variant serves preview/site with a tiny
#   static Node server (SPA fallback + /healthz) and runs the cloudflared static
#   binary directly — same anonymous quick-tunnel, zero account/DNS/port.
#
# OFF-PRODUCTION. Never touches Coolify / liveplace.tv. UI-only, no backend.
#
# CAVEAT (durability): an agent heartbeat sandbox is ephemeral — this PROVES the
# path and serves NOW. Durable always-on hosting needs a persistent host (NAS
# Docker executor or registered NAS executor). That access is account-bound
# (NAS SSH endpoint + key) and is Alexis's call once he's seen the live link.
#
# Usage:
#   scripts/preview-agent-tunnel.sh up      # serve preview/site locally (:PORT)
#   scripts/preview-agent-tunnel.sh tunnel  # up + cloudflared quick-tunnel; prints URL
#   scripts/preview-agent-tunnel.sh url     # print current trycloudflare URL
#   scripts/preview-agent-tunnel.sh smoke   # curl /healthz + assets over the tunnel
#   scripts/preview-agent-tunnel.sh down    # stop serve + tunnel
#
# Env: PREVIEW_PORT (default 8088), CF_BIN (cloudflared path; auto-downloads to
#      /tmp/cloudflared if absent).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SITE_DIR="${REPO_ROOT}/preview/site"
PORT="${PREVIEW_PORT:-8088}"
RUN="/tmp/lp-preview"; mkdir -p "${RUN}"
SERVE_LOG="${RUN}/serve.log"; TUN_LOG="${RUN}/tunnel.log"
CF_BIN="${CF_BIN:-/tmp/cloudflared}"

ensure_cf() {
  [[ -x "${CF_BIN}" ]] && return 0
  local a; a=$(uname -m); case "$a" in x86_64) a=amd64;; aarch64|arm64) a=arm64;; *) a=amd64;; esac
  echo "[preview] downloading cloudflared (${a})..." >&2
  curl -fsSL -o "${CF_BIN}" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${a}" || true
  chmod +x "${CF_BIN}"; "${CF_BIN}" --version >/dev/null
}

serve() {
  pgrep -f "lp-preview-serve.mjs" >/dev/null 2>&1 && { echo "[preview] serve already up on :${PORT}"; return 0; }
  cat > "${RUN}/lp-preview-serve.mjs" <<'JS'
import http from 'node:http';import{readFile,stat}from'node:fs/promises';import{extname,join,normalize}from'node:path';
const ROOT=process.argv[2],PORT=Number(process.argv[3]||8088);
const M={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.json':'application/json','.ico':'image/x-icon','.webmanifest':'application/manifest+json'};
const send=async(res,f,c=200)=>{const d=await readFile(f);res.writeHead(c,{'content-type':M[extname(f)]||'application/octet-stream','cache-control':'no-cache'});res.end(d);};
http.createServer(async(req,res)=>{try{if(req.url==='/healthz'){res.writeHead(200,{'content-type':'text/plain'});return res.end('ok');}
let p=decodeURIComponent(req.url.split('?')[0]);if(p==='/')p='/index.html';
let f=join(ROOT,normalize(p).replace(/^(\.\.[/\\])+/,''));
try{const s=await stat(f);if(s.isDirectory())f=join(f,'index.html');await stat(f);}catch{f=join(ROOT,'index.html');}
await send(res,f);}catch(e){res.writeHead(500);res.end('err');}}).listen(PORT,'0.0.0.0',()=>console.log(`[serve] :${PORT} root=${ROOT}`));
JS
  [[ -f "${SITE_DIR}/index.html" ]] || { echo "[preview] no preview/site/index.html — build the maquettes first" >&2; exit 1; }
  nohup node "${RUN}/lp-preview-serve.mjs" "${SITE_DIR}" "${PORT}" > "${SERVE_LOG}" 2>&1 &
  sleep 1; curl -fsS "http://localhost:${PORT}/healthz" >/dev/null && echo "[preview] serve up on :${PORT}"
}

tunnel() {
  serve; ensure_cf
  pgrep -f "cloudflared tunnel" >/dev/null 2>&1 || \
    nohup "${CF_BIN}" tunnel --no-autoupdate --url "http://localhost:${PORT}" > "${TUN_LOG}" 2>&1 &
  for _ in $(seq 1 30); do
    u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUN_LOG}" 2>/dev/null | head -1)
    [[ -n "${u:-}" ]] && { echo "[preview] PUBLIC URL: ${u}"; return 0; }
    sleep 1
  done
  echo "[preview] tunnel URL not ready — check ${TUN_LOG}" >&2; return 1
}

case "${1:-help}" in
  up) serve ;;
  tunnel) tunnel ;;
  url) grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUN_LOG}" 2>/dev/null | head -1 || echo "[preview] no URL yet" ;;
  smoke)
    u=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUN_LOG}" 2>/dev/null | head -1)
    [[ -z "${u:-}" ]] && { echo "[preview] no tunnel up" >&2; exit 1; }
    echo "healthz=$(curl -fsS -o /dev/null -w '%{http_code}' "$u/healthz")"
    echo "index=$(curl -fsS -o /dev/null -w '%{http_code}' "$u/")"
    echo "css=$(curl -fsS -o /dev/null -w '%{http_code}' "$u/assets/$(ls "${SITE_DIR}/assets" | grep -m1 '\.css$')")" ;;
  down) pkill -f "cloudflared tunnel" 2>/dev/null||true; pkill -f "lp-preview-serve.mjs" 2>/dev/null||true; echo "[preview] down" ;;
  *) sed -n '2,33p' "${BASH_SOURCE[0]}" ;;
esac
