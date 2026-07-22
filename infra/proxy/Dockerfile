# Caddy reverse proxy with the Caddyfile BAKED IN (FEN-80).
#
# WHY baked, not bind-mounted: on Coolify, a `./infra/Caddyfile:/etc/caddy/Caddyfile`
# bind-mount fails — when the daemon resolves the relative host source in the
# deployment artifact it does not find the file and auto-creates it as a
# DIRECTORY, so mounting a dir onto the container file /etc/caddy/Caddyfile errors
# ("Are you trying to mount a directory onto a file?") and the whole `up` aborts.
# COPYing the Caddyfile at build time (the build context provably contains it)
# removes the host-path bind-mount and is reproducible on any host.
#
# Build context = repo root (so `infra/Caddyfile` resolves). $SITE_ADDRESS still
# selects the listener at runtime (see infra/Caddyfile).
FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
