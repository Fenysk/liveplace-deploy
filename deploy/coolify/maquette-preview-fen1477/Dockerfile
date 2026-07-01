# FEN-1478 — build the isolated static preview image for the FEN-1477 maquette.
# Reproducible: image content = the autonomous maquette index.html + a file_server
# Caddyfile, nothing else. No app code, no upstream, no secrets.
FROM caddy:2-alpine
COPY Caddyfile /etc/caddy/Caddyfile
COPY index.html /srv/index.html
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
EXPOSE 80
