# @canvas/gateway — monorepo-aware image. Build context = repo root.
# Multi-arch: runs on arm64 (NAS) and amd64 via the node base image.
#
# Canonical (_default) apps run straight from TypeScript via `tsx` — workspace
# packages export `./src/index.ts` (no dist/), so there is NO compile/`deploy`
# step. We install the workspace, copy sources, and run `pnpm start` (tsx).
FROM node:22-alpine AS base
# Pin the corepack cache to a shared, stable path. Default is per-user
# (~/.cache/node/corepack), so the pnpm tarball downloaded by root at install
# time would be invisible to a non-root runtime user and trigger an offline
# re-download. A fixed COREPACK_HOME is populated once (deps stage) and reused by
# every stage — incl. the unprivileged runtime below (FEN-87 non-root).
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Copy every workspace manifest first so `--frozen-lockfile` resolves the full
# graph and this layer caches across source changes. pnpm-workspace.yaml globs
# packages/* + apps/*, so all members must be present at install time.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/convex/package.json apps/convex/
COPY packages/protocol/package.json packages/protocol/
COPY packages/redis-scripts/package.json packages/redis-scripts/
COPY packages/i18n/package.json packages/i18n/
# Dev deps included on purpose: tsx is the runtime for canonical apps.
RUN pnpm install --frozen-lockfile

FROM deps AS runtime
# Sources the gateway actually needs (it imports @canvas/protocol + redis-scripts).
COPY packages ./packages
COPY apps/gateway ./apps/gateway
EXPOSE 8080
# Drop root (FEN-87): run as the unprivileged built-in `node` user (uid 1000).
# The app tree is copied 0644/0755 by root and is world-readable, so tsx reads
# sources fine and nothing is written under /app at runtime. Only the corepack
# cache needs to be writable by `node` (corepack may refresh its lock on run).
RUN chown -R node:node "$COREPACK_HOME"
USER node
# `start` == `tsx src/index.ts`. busybox wget (alpine) backs the compose healthcheck.
CMD ["pnpm", "--filter", "@canvas/gateway", "start"]
