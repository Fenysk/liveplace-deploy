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
# Environment vars (INSTANCE_NAME, INSTANCE_SECRET) provided at runtime via
# docker-compose.yml environment section.
CMD ["/bin/sh", "/mint.sh"]
