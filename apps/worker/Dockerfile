# @canvas/worker — persistence worker image. Build context = repo root.
# Multi-arch (arm64 NAS + amd64). Background service: NO ports exposed.
#
# Like the gateway, the canonical worker runs from TS via `tsx` (its `start`
# script), so there is no compile/`deploy` step. tsx is a devDependency of the
# worker, so we install WITH dev deps (never set NODE_ENV=production pre-install).
FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Full manifest set so `--frozen-lockfile` resolves the whole workspace graph.
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
# The worker imports @canvas/protocol + @canvas/redis-scripts (source).
COPY packages ./packages
COPY apps/worker ./apps/worker
# `start` == `tsx src/index.ts`. No EXPOSE — the worker opens no listener.
CMD ["pnpm", "--filter", "@canvas/worker", "start"]
