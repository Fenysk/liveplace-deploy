# convex-admin-key — one-shot image that mints the Convex self-hosted admin key
# in-stack without any manual terminal (FEN-92).
#
# Inherits from the same convex-backend image so generate_admin_key.sh is always
# present and runs in the correct environment (same glibc, same binary path as
# when the script is invoked via `docker compose exec backend ./generate_admin_key.sh`).
# Build context = repo root so `infra/convex-admin-key/mint.sh` resolves.
FROM ghcr.io/get-convex/convex-backend:latest
COPY infra/convex-admin-key/mint.sh /mint.sh
RUN chmod +x /mint.sh
# RESET the inherited ENTRYPOINT (FEN-96 — the bug behind the misleading deploy
# `failed`). The convex-backend `:latest` image carries an ENTRYPOINT that execs
# the Rust backend binary; WITHOUT this reset our CMD below is appended as
# ARGUMENTS to that entrypoint instead of being run, so the backend binary gets
# `/bin/sh /mint.sh`, clap rejects the unknown args, and the container exits 2 —
# mint.sh never runs. That exit-2 (via convex-deploy's completed-successfully
# gate) is exactly what made `docker compose up -d` return non-zero and Coolify
# mark a working deploy `failed`. `ENTRYPOINT []` makes CMD the WHOLE command so
# mint.sh actually runs (and exits 0). Correct whether or not the base ships an
# entrypoint, so it also immunises us against future `:latest` drift.
ENTRYPOINT []
# Environment vars (INSTANCE_NAME, INSTANCE_SECRET) provided at runtime via
# docker-compose.yml environment section.
CMD ["/bin/sh", "/mint.sh"]
