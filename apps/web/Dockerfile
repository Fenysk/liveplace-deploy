# @canvas/web — Vite SPA image. Build context = repo root. Multi-arch.
#
# Canonical web is a PURE client SPA: `build` == `tsc --noEmit && vite build`,
# producing static assets in apps/web/dist. There is no app-tier server (auth is
# served by Convex). So we build the assets in one stage and serve them with a
# tiny stdlib static server (infra/web-serve.mjs) in the runtime stage.
#
# VITE_* are inlined at BUILD time, so the public Convex URLs must be passed as
# build args (they are public origins, not secrets).
#
# Base image note (FEN-78 #1): the `convex codegen` step below runs the Convex
# native binary, which is glibc-only and crashes on Alpine/musl. So the BUILD
# stage uses a glibc base (node:22-bookworm-slim); tsc/vite build there too. The
# runtime stage stays on alpine — it only serves static files, no Convex binary.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS build
ARG VITE_CONVEX_URL
ARG VITE_CONVEX_SITE_URL
ENV VITE_CONVEX_URL=${VITE_CONVEX_URL}
ENV VITE_CONVEX_SITE_URL=${VITE_CONVEX_SITE_URL}
# Manifests first for a cacheable install layer.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/convex/package.json apps/convex/
COPY packages/protocol/package.json packages/protocol/
COPY packages/redis-scripts/package.json packages/redis-scripts/
COPY packages/i18n/package.json packages/i18n/
COPY packages/points-rules/package.json packages/points-rules/
RUN pnpm install --frozen-lockfile
# Sources: web + the workspace packages it imports, plus apps/convex so the
# generated `@canvas/convex/api` (imported by ProfilePage) is available.
COPY packages ./packages
COPY apps/convex ./apps/convex
# CACHE_BUST can be passed as --build-arg CACHE_BUST=$(date +%s) to force a fresh
# copy of apps/web and downstream build (bypasses Docker BuildKit layer cache).
ARG CACHE_BUST=default
COPY apps/web ./apps/web
# Regenerate @canvas/convex/_generated (api/dataModel/server) when possible.
# The _generated files are COMMITTED (FEN-73) and copied in above, so the web
# typecheck/build does not depend on this. convex ≥1.39 `codegen` requires a
# deployment config (CONVEX_DEPLOYMENT) which is absent in an offline image
# build — so run it best-effort and fall back to the committed _generated rather
# than failing the whole build (FEN-80: this hard-failed every VPS deploy; the
# web build compiles cleanly from the committed files — verified).
RUN pnpm --filter @canvas/convex codegen || echo "[web build] convex codegen unavailable offline — using committed _generated"
# Fail fast if VITE_CONVEX_URL is empty — an empty URL is silently baked into
# the bundle (ConvexReactClient("") throws "not an absolute URL" at runtime).
RUN test -n "$VITE_CONVEX_URL" || { echo "❌ VITE_CONVEX_URL is empty — set PUBLIC_BASE_URL in deploy.env before building"; exit 1; }
RUN pnpm --filter @canvas/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY infra/web-serve.mjs ./web-serve.mjs
COPY --from=build /app/apps/web/dist ./public
EXPOSE 3000
# Drop root (FEN-87): the static server only reads /app/public (world-readable)
# and binds an unprivileged port (3000 > 1024), so the built-in `node` user
# (uid 1000) suffices. No corepack/pnpm at runtime here.
USER node
# busybox wget (alpine) backs the compose healthcheck against /healthz.
CMD ["node", "web-serve.mjs"]
