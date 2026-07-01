# @canvas/convex — one-shot deploy image. Build context = repo root. Multi-arch.
#
# This image is NOT a long-running service. The compose `convex-deploy` service
# runs it once after convex-backend is healthy to push the canvas functions
# (`canvases:*`, `worker:*`, `gallery:*`, auth HTTP routes, …) into the
# self-hosted backend, then exits. The gateway/worker/web depend on it having
# completed so they connect to a deployed backend (boot-sequence wiring, FEN-69).
#
# Self-hosted deploy reads CONVEX_SELF_HOSTED_URL + CONVEX_SELF_HOSTED_ADMIN_KEY
# from the environment (provided via .env / Docker secrets — never baked in).
#
# Base image (FEN-78 #1): `convex deploy` runs the Convex native binary, which is
# glibc-only and crashes on Alpine/musl. Use a glibc base so this one-shot runs
# on a clean Docker host without manual intervention.
FROM node:22-bookworm-slim AS base
# Pin the corepack cache to a shared path so the pnpm tarball fetched by root at
# install time is reused by the non-root runtime user (default cache is per-user
# and would force an offline re-download). See FEN-87.
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/convex/package.json apps/convex/
COPY packages/protocol/package.json packages/protocol/
COPY packages/redis-scripts/package.json packages/redis-scripts/
COPY packages/i18n/package.json packages/i18n/
RUN pnpm install --frozen-lockfile

FROM deps AS runtime
COPY packages ./packages
COPY apps/convex ./apps/convex
# Drop root (FEN-87): run this one-shot as the unprivileged `node` user (uid
# 1000). deploy.sh writes a transient dotenv in its cwd and `convex deploy` may
# (re)write _generated, so the convex app dir must be node-writable; the corepack
# cache must be too. HOME (/home/node) covers any convex CLI cache.
RUN chown -R node:node /app/apps/convex "$COREPACK_HOME"
USER node
WORKDIR /app/apps/convex
# Deploy the functions, then seed the deployment env vars they read via
# process.env (self-hosted Convex keeps those IN the deployment, not the
# container env — see deploy.sh). URL + admin key come from env / Docker secrets.
CMD ["sh", "./deploy.sh"]
